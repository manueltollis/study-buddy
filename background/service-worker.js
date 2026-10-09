/**
 * Background service worker.
 *
 * Owns everything that touches the Anthropic API: the key never leaves this
 * context, and page scripts can never reach it. Content scripts open a port,
 * ask a question, and receive streamed deltas back.
 */
import {
  ACTIONS,
  activeBaseUrl,
  activeKey,
  activeModel,
  buildUserMessage,
  estimateCost,
  getSettings,
  isAnthropic,
  supportsEffort,
  supportsFallbacks,
  systemPrompt,
  wireOf
} from '../lib/config.js';
import { fileNote, streamCollector, undoOps } from '../lib/librarian.js';
import { createVault } from '../lib/vault.js';

const API_VERSION = '2023-06-01';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const PORT_NAME = 'claude-study';

/* ------------------------------------------------------------------ API */

const endpointFor = (settings) =>
  wireOf(settings) === 'openai'
    ? `${activeBaseUrl(settings)}/chat/completions`
    : `${activeBaseUrl(settings)}/v1/messages`;

/** OpenAI Chat Completions shape, for gateways that speak it (OpenRouter, local servers). */
function buildOpenAiBody(settings, { system, messages, maxTokens, stream, tools }) {
  const body = {
    model: activeModel(settings),
    max_tokens: maxTokens || settings.maxTokens,
    messages: [{ role: 'system', content: system }, ...messages]
  };
  if (tools) body.tools = tools;
  if (stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  return body;
}

function buildBody(settings, { system, messages, maxTokens, stream, tools, withFallbacks }) {
  if (wireOf(settings) === 'openai') {
    return buildOpenAiBody(settings, { system, messages, maxTokens, stream, tools });
  }
  const body = {
    model: activeModel(settings),
    max_tokens: maxTokens || settings.maxTokens,
    system: [{ type: 'text', text: system }],
    messages
  };
  if (tools) body.tools = tools;
  if (stream) body.stream = true;
  if (supportsEffort(settings)) {
    body.output_config = { effort: settings.effort };
    if (settings.showReasoning) body.thinking = { type: 'adaptive', display: 'summarized' };
  }
  if (withFallbacks) body.fallbacks = 'default';
  return body;
}

function headersFor(settings, withFallbacks) {
  const key = activeKey(settings);
  if (wireOf(settings) === 'openai') {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
      // Attribution on gateways that show it (OpenRouter's activity dashboard).
      'x-title': 'Study Buddy'
    };
  }
  const headers = { 'content-type': 'application/json', 'anthropic-version': API_VERSION };
  if (isAnthropic(settings)) {
    headers['x-api-key'] = key;
    // Required for requests that originate from a browser context.
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
    if (withFallbacks) headers['anthropic-beta'] = FALLBACK_BETA;
    // Keys that are not scoped to one workspace must name the workspace they act in.
    if (settings.workspaceId) headers['anthropic-workspace-id'] = settings.workspaceId.trim();
  } else {
    // Anthropic-compatible gateways differ on which auth header they read.
    headers.authorization = `Bearer ${key}`;
    headers['x-api-key'] = key;
  }
  return headers;
}

const WORKSPACE_HELP =
  'This key works across several workspaces, so the API needs to know which one the request acts in. ' +
  'Open the extension settings and paste your workspace ID (wrkspc_…) — you\'ll find it in the ID column of Console → Settings → Workspaces.';

function describeError(status, payload, rawText) {
  const apiMessage = payload?.error?.message || rawText || '';
  switch (status) {
    case 401:
    case 403:
      return 'That API key was rejected. Check it in the extension options (it should start with "sk-ant-").';
    case 400:
      if (/anthropic-workspace-id/i.test(apiMessage)) {
        return WORKSPACE_HELP;
      }
      return apiMessage ? `API error 400: ${apiMessage}` : 'API error 400.';
    case 404:
      if (/workspace/i.test(apiMessage)) {
        return 'That workspace ID was not found, or this key has no access to it. Check it in the extension settings.';
      }
      return 'That model is not available to this API key. Pick a different model in options.';
    case 402:
      return 'That account is out of credit. Top it up with your provider and try again.';
    case 429:
      return 'Rate limited by the API. Wait a moment and try again.';
    case 500:
    case 502:
    case 503:
      return 'The API had a server error. Try again in a moment.';
    case 529:
      return 'The API is overloaded right now. Try again shortly.';
    default:
      return apiMessage ? `API error ${status}: ${apiMessage}` : `API error ${status}.`;
  }
}

async function postToApi(settings, options, withFallbacks, signal) {
  return fetch(endpointFor(settings), {
    method: 'POST',
    headers: headersFor(settings, withFallbacks),
    body: JSON.stringify(buildBody(settings, { ...options, withFallbacks })),
    signal
  });
}

/**
 * Sends a request, retrying once without the refusal-fallback beta if the
 * account is not enrolled in it.
 */
async function sendRequest(settings, options, signal) {
  let withFallbacks = settings.useFallbacks && supportsFallbacks(settings);
  let response = await postToApi(settings, options, withFallbacks, signal);

  if (!response.ok && response.status === 400 && withFallbacks) {
    const text = await response.text();
    if (/fallback|beta/i.test(text)) {
      withFallbacks = false;
      response = await postToApi(settings, options, false, signal);
    } else {
      return { response, preReadText: text };
    }
  }
  return { response, preReadText: null };
}

/** Yields each parsed `data:` frame of a server-sent event stream. */
async function* sseEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';
    for (const chunk of chunks) {
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let event;
        try {
          event = JSON.parse(data);
        } catch {
          continue; /* partial or unknown frame - ignore */
        }
        yield event;
      }
    }
  }
}

/** Parses the SSE stream and pushes semantic events to `emit`. */
async function readStream(response, emit, wire) {
  let text = '';
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  let stopReason = null;
  let servedBy = null;

  const handleOpenAi = (event) => {
    if (event.error) {
      emit({ type: 'error', message: event.error.message || 'Stream error.' });
      return;
    }
    if (event.model) servedBy = event.model;
    const choice = (event.choices || [])[0];
    if (choice) {
      const delta = choice.delta || {};
      if (delta.content) {
        text += delta.content;
        emit({ type: 'delta', text: delta.content });
      }
      if (delta.reasoning) emit({ type: 'reasoning', text: delta.reasoning });
      if (choice.finish_reason) stopReason = choice.finish_reason;
    }
    if (event.usage) {
      usage.input_tokens = event.usage.prompt_tokens || usage.input_tokens;
      usage.output_tokens = event.usage.completion_tokens || usage.output_tokens;
    }
  };

  const handleAnthropic = (event) => {
    switch (event.type) {
      case 'message_start':
        servedBy = event.message?.model || servedBy;
        Object.assign(usage, event.message?.usage || {});
        break;
      case 'content_block_start':
        if (event.content_block?.type === 'fallback') {
          emit({ type: 'notice', text: `Switched to ${event.content_block.to?.model || 'a fallback model'}.` });
        }
        break;
      case 'content_block_delta':
        if (event.delta?.type === 'text_delta') {
          text += event.delta.text;
          emit({ type: 'delta', text: event.delta.text });
        } else if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
          emit({ type: 'reasoning', text: event.delta.thinking });
        }
        break;
      case 'message_delta':
        if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
        if (event.usage) Object.assign(usage, event.usage);
        break;
      case 'error':
        emit({ type: 'error', message: event.error?.message || 'Stream error.' });
        break;
      default:
        break;
    }
  };

  const handle = wire === 'openai' ? handleOpenAi : handleAnthropic;
  for await (const event of sseEvents(response)) handle(event);

  return { text, usage, stopReason, servedBy };
}

/* -------------------------------------------------------------- ask flow */

async function handleAsk(msg, send, signal) {
  const settings = await getSettings();
  if (!activeKey(settings)) {
    send({ type: 'error', requestId: msg.requestId, message: 'No API key set yet.', needsKey: true });
    return;
  }
  if (!activeBaseUrl(settings)) {
    send({
      type: 'error',
      requestId: msg.requestId,
      message: 'No endpoint URL set for this provider.',
      needsKey: true
    });
    return;
  }

  const history = Array.isArray(msg.history) ? msg.history : [];
  const action = ACTIONS[msg.payload.action];
  // First turn carries the passage and page context; later turns are either a
  // typed question or another action applied to the passage already in thread.
  const userMessage = history.length
    ? (action ? action.instruction : msg.payload.question)
    : buildUserMessage(msg.payload);

  if (!userMessage || !userMessage.trim()) {
    send({ type: 'error', requestId: msg.requestId, message: 'Nothing to ask about.' });
    return;
  }

  const messages = [...history, { role: 'user', content: userMessage }];
  send({ type: 'start', requestId: msg.requestId, userMessage, model: activeModel(settings) });

  let response;
  let preReadText;
  try {
    ({ response, preReadText } = await sendRequest(
      settings,
      { system: systemPrompt(settings), messages, stream: true },
      signal
    ));
  } catch (error) {
    if (error.name === 'AbortError') return;
    send({
      type: 'error',
      requestId: msg.requestId,
      message: `Could not reach the API (${error.message}). Check your connection.`
    });
    return;
  }

  if (!response.ok) {
    const raw = preReadText ?? (await response.text());
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      /* non-JSON error body */
    }
    send({
      type: 'error',
      requestId: msg.requestId,
      message: describeError(response.status, payload, raw),
      needsKey:
        response.status === 401 ||
        response.status === 403 ||
        /anthropic-workspace-id|workspace/i.test(raw)
    });
    return;
  }

  try {
    const result = await readStream(
      response,
      (event) => send({ ...event, requestId: msg.requestId }),
      wireOf(settings)
    );
    if (result.stopReason === 'refusal' || result.stopReason === 'content_filter') {
      send({
        type: 'notice',
        requestId: msg.requestId,
        text: 'The model declined to answer this one. Rephrasing the question usually helps.'
      });
    }
    const model = result.servedBy || activeModel(settings);
    send({
      type: 'done',
      requestId: msg.requestId,
      text: result.text,
      usage: result.usage,
      cost: estimateCost(model, result.usage, settings),
      model,
      stopReason: result.stopReason
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      send({ type: 'aborted', requestId: msg.requestId });
      return;
    }
    send({ type: 'error', requestId: msg.requestId, message: `Stream failed: ${error.message}` });
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  let controller = null;
  let connected = true;

  const send = (message) => {
    if (!connected) return;
    try {
      port.postMessage(message);
    } catch {
      connected = false;
    }
  };

  port.onDisconnect.addListener(() => {
    connected = false;
    controller?.abort();
  });

  port.onMessage.addListener((msg) => {
    if (msg?.type === 'cancel') {
      controller?.abort();
      return;
    }
    if (msg?.type !== 'ask') return;
    controller?.abort();
    controller = new AbortController();
    handleAsk(msg, send, controller.signal).catch((error) =>
      send({ type: 'error', requestId: msg.requestId, message: String(error?.message || error) })
    );
  });
});

/* --------------------------------------------------- Obsidian librarian */

/** Per-note filing state, keyed by note id: status, progress, summary, and the undo journal. */
const VAULT_KEY = 'vault';
const vaultQueue = [];
let vaultRunning = false;
/** Serializes read-modify-writes of the journal. */
let journalWrite = Promise.resolve();

function updateFiling(noteId, patch) {
  journalWrite = journalWrite.catch(() => {}).then(async () => {
    const store = await chrome.storage.local.get(VAULT_KEY);
    const all = store[VAULT_KEY] || {};
    all[noteId] = { ...(all[noteId] || {}), ...patch, at: Date.now() };
    await chrome.storage.local.set({ [VAULT_KEY]: all });
  });
  return journalWrite;
}

const vaultReady = (settings) => Boolean(settings.vaultKey);
const vaultFor = (settings) => createVault({ url: settings.vaultUrl, key: settings.vaultKey });

/** The answering settings, tuned for filing: its own model if set, no visible reasoning, quick effort. */
function librarianSettings(settings) {
  const model = (settings.vaultModel || '').trim();
  return {
    ...settings,
    models: model ? { ...settings.models, [settings.provider]: model } : settings.models,
    effort: 'low',
    showReasoning: false,
    useFallbacks: false,
    // Room to write a whole note in one tool call.
    maxTokens: Math.max(settings.maxTokens, 8000)
  };
}

/**
 * One request, resolving with the body a non-streaming call would return.
 * It streams anyway: Chrome stops the worker if a response takes more than
 * 30 seconds to start arriving, and writing out a long note takes longer.
 */
async function complete(settings, options) {
  const { response, preReadText } = await sendRequest(settings, { ...options, stream: true }, undefined);
  if (!response.ok) {
    const raw = preReadText ?? (await response.text());
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      /* non-JSON error body */
    }
    throw new Error(describeError(response.status, payload, raw));
  }
  const collector = streamCollector(wireOf(settings));
  for await (const event of sseEvents(response)) collector.push(event);
  return collector.result();
}

function queueFiling(noteId) {
  if (vaultQueue.includes(noteId)) return;
  vaultQueue.push(noteId);
  updateFiling(noteId, { status: 'queued', step: '', error: '' });
  drainVaultQueue();
}

async function drainVaultQueue() {
  if (vaultRunning) return;
  vaultRunning = true;
  try {
    while (vaultQueue.length) await fileOne(vaultQueue[0]).finally(() => vaultQueue.shift());
  } finally {
    vaultRunning = false;
  }
}

async function fileOne(noteId) {
  const store = await chrome.storage.local.get('notes');
  const note = (store.notes || []).find((n) => n.id === noteId);
  // Taken back out of the notes before its turn came.
  if (!note) return updateFiling(noteId, { status: 'failed', error: 'The note was deleted before it could be filed.' });

  const settings = librarianSettings(await getSettings());
  if (!vaultReady(settings)) return updateFiling(noteId, { status: 'failed', error: 'No vault connected. Set one up in settings.' });
  if (!activeKey(settings) || !activeBaseUrl(settings)) {
    return updateFiling(noteId, { status: 'failed', error: 'No API key set for the current provider.' });
  }

  // A retry after a failure keeps the earlier attempt's writes, so Undo still reaches them.
  const previous = ((await chrome.storage.local.get(VAULT_KEY))[VAULT_KEY] || {})[noteId];
  const prior = previous?.status === 'failed' ? previous.ops || [] : [];
  await updateFiling(noteId, { status: 'working', step: 'Looking at the vault', ops: prior, summary: '', error: '' });
  // Chrome also stops a worker after 30 seconds without extension activity, and
  // a streamed reply alone doesn't count. Any API call resets that clock.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
  try {
    const result = await fileNote({
      note,
      vault: vaultFor(settings),
      wire: wireOf(settings),
      folder: settings.vaultFolder,
      appendOutside: settings.vaultAppendOutside,
      complete: (options) => complete(settings, options),
      // Each step is a storage write, which also keeps the worker alive through a long filing.
      onStep: (step) => updateFiling(noteId, { step })
    });
    const model = result.model || activeModel(settings);
    await updateFiling(noteId, {
      status: 'filed',
      step: '',
      summary: result.summary,
      ops: [...prior, ...result.ops],
      suggestions: result.suggestions,
      unlinked: result.unlinked,
      model,
      cost: estimateCost(model, result.usage, settings)
    });
  } catch (error) {
    await updateFiling(noteId, {
      status: 'failed',
      step: '',
      error: String(error?.message || error),
      ops: [...prior, ...(error.ops || [])]
    });
  } finally {
    clearInterval(keepAlive);
  }
}

async function undoFiling(noteId) {
  const store = await chrome.storage.local.get(VAULT_KEY);
  const entry = (store[VAULT_KEY] || {})[noteId];
  if (!entry?.ops?.length) return { ok: false, message: 'Nothing to undo.' };
  const settings = await getSettings();
  try {
    const { undone, skipped } = await undoOps(vaultFor(settings), entry.ops);
    await updateFiling(noteId, { status: skipped.length ? 'filed' : 'undone', ops: skipped.length ? entry.ops : [] });
    return skipped.length
      ? { ok: false, message: `Undid ${undone} change${undone === 1 ? '' : 's'}; left ${skipped.join(', ')} alone because it was edited since.` }
      : { ok: true, message: `Undid ${undone} change${undone === 1 ? '' : 's'}.` };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

// Answers saved while auto-filing is on go to the librarian as they land.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes.notes) return;
  const before = new Set((changes.notes.oldValue || []).map((note) => note.id));
  const added = (changes.notes.newValue || []).filter((note) => !before.has(note.id));
  if (!added.length) return;
  const settings = await getSettings();
  if (!settings.vaultAutoFile || !vaultReady(settings)) return;
  for (const note of added) queueFiling(note.id);
});

// A fresh worker has an empty queue, so anything still marked in progress was cut off.
(async () => {
  const store = await chrome.storage.local.get(VAULT_KEY);
  const stale = Object.entries(store[VAULT_KEY] || {}).filter(([, e]) => e.status === 'queued' || e.status === 'working');
  for (const [noteId, entry] of stale) {
    if (vaultQueue.includes(noteId)) continue;
    updateFiling(noteId, { status: 'failed', step: '', error: 'Interrupted. Try again.', ops: entry.ops || [] });
  }
})();

/* ------------------------------------------------- one-off page requests */

const PAGES = {
  notes: 'notes/notes.html',
  options: 'options/options.html'
};

/* ------------------------------------------------------------ PDF viewer */

const VIEWER_PATH = 'viewer/viewer.html';
const viewerUrl = (url) => `${chrome.runtime.getURL(VIEWER_PATH)}?file=${encodeURIComponent(url)}`;
/** Tabs the user explicitly sent to Chrome's own PDF viewer, so we let them through once. */
const bypass = new Map();

/**
 * Chrome's PDF plugin exposes no text DOM, so a PDF URL is sent to the
 * extension's viewer instead. Detection is by URL: a `.pdf` file, or the
 * `/pdf/<id>` shape that arXiv, bioRxiv and friends use.
 */
function looksLikePdf(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol)) return null;
  const path = parsed.pathname;
  if (/\.pdf$/i.test(path)) return 'certain';
  // arXiv, bioRxiv and friends serve PDFs from an extensionless /pdf/<id> path.
  return /\/pdf\/[^/]+\/?$/i.test(path) ? 'probable' : null;
}

/** Confirms an extensionless URL really is a PDF before hijacking the tab. */
async function confirmPdf(url) {
  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    const type = response.headers.get('content-type') || '';
    if (/pdf/i.test(type)) return true;
    if (/html|json|xml|plain/i.test(type)) return false;
  } catch {
    /* HEAD blocked or offline - fall back to the URL shape */
  }
  return true;
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  const url = changeInfo.url;
  if (!url || url.startsWith('chrome-extension:')) return;
  if (bypass.get(tabId) === url) {
    bypass.delete(tabId);
    return;
  }
  const verdict = looksLikePdf(url);
  if (!verdict) return;
  const settings = await getSettings();
  if (!settings.pdfViewer) return;
  if (verdict === 'probable' && !(await confirmPdf(url))) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  // The user may have navigated on during the HEAD check.
  if (!tab || tab.url !== url) {
    if (tab && tab.pendingUrl !== url && tab.url !== url) return;
  }
  chrome.tabs.update(tabId, { url: viewerUrl(url) }).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => bypass.delete(tabId));

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'open-original' && _sender.tab?.id) {
    // Let this one navigation through without bouncing back to the viewer.
    bypass.set(_sender.tab.id, message.url);
    chrome.tabs.update(_sender.tab.id, { url: message.url });
    return false;
  }
  if (message?.type === 'open-pdf') {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id && message.url) chrome.tabs.update(tab.id, { url: viewerUrl(message.url) });
    })();
    return false;
  }
  if (message?.type === 'open-page') {
    const page = PAGES[message.page];
    if (page) chrome.tabs.create({ url: chrome.runtime.getURL(page) });
    return false;
  }
  if (message?.type === 'proxy-action' || message?.type === 'proxy-toggle') {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return;
      await sendToTab(
        tab.id,
        message.type === 'proxy-toggle'
          ? { type: 'toggle-panel' }
          : { type: 'run-action', action: message.action }
      );
    })();
    return false;
  }
  if (message?.type === 'vault-test') {
    (async () => {
      const settings = { ...(await getSettings()), ...(message.overrides || {}) };
      if (!settings.vaultKey) {
        sendResponse({ ok: false, message: 'Paste the API key from the Local REST API plugin first.' });
        return;
      }
      try {
        const vault = vaultFor(settings);
        const info = await vault.ping();
        const root = await vault.list('');
        sendResponse({
          ok: true,
          message: `Connected to Obsidian ${info.versions?.obsidian || ''} — ${root.length} item${root.length === 1 ? '' : 's'} at the vault root.`
        });
      } catch (error) {
        sendResponse({ ok: false, message: error.message });
      }
    })();
    return true;
  }
  if (message?.type === 'vault-file') {
    queueFiling(message.noteId);
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'vault-undo') {
    undoFiling(message.noteId).then(sendResponse);
    return true;
  }
  if (message?.type === 'test-key') {
    (async () => {
      const settings = { ...(await getSettings()), ...(message.overrides || {}) };
      if (!activeKey(settings)) {
        sendResponse({ ok: false, message: 'Enter an API key first.' });
        return;
      }
      if (!activeBaseUrl(settings)) {
        sendResponse({ ok: false, message: 'Enter the endpoint URL for this provider first.' });
        return;
      }
      try {
        const { response, preReadText } = await sendRequest(
          settings,
          {
            system: 'Reply with exactly: OK',
            messages: [{ role: 'user', content: 'Say OK.' }],
            maxTokens: 16,
            stream: false
          },
          undefined
        );
        if (!response.ok) {
          const raw = preReadText ?? (await response.text());
          let payload = null;
          try {
            payload = JSON.parse(raw);
          } catch {
            /* ignore */
          }
          sendResponse({ ok: false, message: describeError(response.status, payload, raw) });
          return;
        }
        const data = await response.json();
        const workspace = response.headers.get('anthropic-workspace-id');
        sendResponse({
          ok: true,
          message: `Key works. Answered by ${data.model || activeModel(settings)}${workspace ? ` in workspace ${workspace}` : ''}.`,
          workspaceId: workspace
        });
      } catch (error) {
        sendResponse({ ok: false, message: `Request failed: ${error.message}` });
      }
    })();
    return true;
  }
  return false;
});

/* ------------------------------------------------ menus and shortcuts */

const MENU_ACTIONS = ['explain', 'simplify', 'keypoints', 'example', 'terms', 'quiz'];

function buildMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'claude-study-root',
      title: 'Study Buddy',
      contexts: ['selection', 'page']
    });
    for (const id of MENU_ACTIONS) {
      chrome.contextMenus.create({
        id: `action:${id}`,
        parentId: 'claude-study-root',
        title: ACTIONS[id].label,
        contexts: ['selection']
      });
    }
    chrome.contextMenus.create({
      id: 'sep',
      parentId: 'claude-study-root',
      type: 'separator',
      contexts: ['selection', 'page']
    });
    chrome.contextMenus.create({
      id: 'action:highlight',
      parentId: 'claude-study-root',
      title: 'Highlight (no question)',
      contexts: ['selection']
    });
    chrome.contextMenus.create({
      id: 'action:pageSummary',
      parentId: 'claude-study-root',
      title: ACTIONS.pageSummary.label,
      contexts: ['selection', 'page']
    });
    chrome.contextMenus.create({
      id: 'action:pageQuiz',
      parentId: 'claude-study-root',
      title: ACTIONS.pageQuiz.label,
      contexts: ['selection', 'page']
    });
  });
}

chrome.runtime.onInstalled.addListener(async (details) => {
  buildMenus();
  if (details.reason === 'install') {
    const settings = await getSettings();
    if (!activeKey(settings)) chrome.runtime.openOptionsPage();
  }
});
chrome.runtime.onStartup.addListener(buildMenus);

/** Sends to a tab, injecting the content script first if it is not there yet. */
async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['lib/markdown.js', 'content/content.js']
      });
      await chrome.scripting.insertCSS({ target: { tabId }, files: ['content/content.css'] });
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      console.warn('Study Buddy: cannot run on this page.', error);
      return null;
    }
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id || !info.menuItemId.startsWith('action:')) return;
  sendToTab(tab.id, {
    type: 'run-action',
    action: info.menuItemId.slice('action:'.length),
    selectionText: info.selectionText || ''
  });
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  if (command === 'explain-selection') {
    sendToTab(tab.id, { type: 'run-action', action: 'explain' });
  } else if (command === 'toggle-panel') {
    sendToTab(tab.id, { type: 'toggle-panel' });
  }
});
