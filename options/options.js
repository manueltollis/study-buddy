import {
  DEFAULT_SETTINGS,
  EFFORT_LEVELS,
  PROVIDERS,
  getSettings,
  modelsFor,
  priceOf,
  saveSettings
} from '../lib/config.js';

const $ = (id) => document.getElementById(id);
const NUMBER_FIELDS = ['maxTokens', 'contextChars'];
const SIMPLE_FIELDS = ['effort', 'level', 'customWire', 'theme'];
const CHECK_FIELDS = ['showReasoning', 'useFallbacks', 'bubbleEnabled', 'autoHighlight', 'autoSaveNotes', 'pdfViewer'];

/** A representative question, used to translate token prices into something legible. */
const TYPICAL = { input: 500, output: 200 };

let settings = { ...DEFAULT_SETTINGS };
/** modelId -> [in, out] for the current provider's fetched catalog. */
let catalog = new Map();

/** Pulls a provider's live model list (id + price), cached for a day. */
async function loadCatalog(providerId, force) {
  const provider = PROVIDERS[providerId];
  catalog = new Map();
  $('modelList').replaceChildren();
  if (!provider || !provider.catalogUrl) return;

  const cacheKey = `catalog:${providerId}`;
  const status = $('catalogStatus');
  const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];
  const fresh = cached && Date.now() - cached.fetchedAt < 24 * 60 * 60 * 1000;

  let entries = fresh && !force ? cached.models : null;
  if (!entries) {
    status.className = 'status';
    status.textContent = 'Loading models…';
    try {
      const response = await fetch(provider.catalogUrl);
      const data = await response.json();
      entries = (data.data || [])
        .map((m) => ({
          id: m.id,
          name: m.name,
          price: [Number(m.pricing?.prompt || 0) * 1e6, Number(m.pricing?.completion || 0) * 1e6]
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
      await chrome.storage.local.set({ [cacheKey]: { fetchedAt: Date.now(), models: entries } });
    } catch (error) {
      status.className = 'status err';
      status.textContent = `Could not load the model list (${error.message}). Type a model name by hand.`;
      entries = cached ? cached.models : [];
    }
  }

  for (const entry of entries) catalog.set(entry.id, entry.price);
  $('modelList').replaceChildren(
    ...entries.map((entry) => {
      const option = document.createElement('option');
      option.value = entry.id;
      const free = entry.price[0] === 0 && entry.price[1] === 0;
      option.label = free ? `${entry.name} — free` : `${entry.name} — $${entry.price[0]}/$${entry.price[1]} per Mtok`;
      return option;
    })
  );
  if (entries.length) {
    status.className = 'status ok';
    status.textContent = `${entries.length} models available.`;
  }
  showPrice();
}

function options(select, values, labels) {
  select.replaceChildren(
    ...values.map((value, i) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = labels ? labels[i] : value;
      return option;
    })
  );
}

function currentModel() {
  return modelsFor(settings.provider).length ? $('model').value : $('customModel').value.trim();
}

function showPrice() {
  const model = currentModel();
  const price = priceOf(model) || catalog.get(model) || settings.prices[model];
  if (price && !priceOf(model)) {
    // Remember it so the panel can price answers from this model too.
    if (String(settings.prices[model]) !== String(price)) saveSettings({ prices: { [model]: price } });
  }
  if (!price) {
    $('priceHint').textContent = settings.provider === 'custom' ? 'Cost readout is unavailable for custom endpoints.' : '';
    return;
  }
  const perQuestion = (TYPICAL.input * price[0] + TYPICAL.output * price[1]) / 1e6;
  if (!perQuestion) {
    $('priceHint').textContent = 'Free on this provider.';
    return;
  }
  const perDollar = Math.round(1 / perQuestion);
  $('priceHint').textContent =
    `$${price[0]} in / $${price[1]} out per million tokens — roughly ${perDollar.toLocaleString()} questions per $1.`;
}

function applyProviderUI() {
  const provider = PROVIDERS[settings.provider];
  const isCustom = settings.provider === 'custom';

  for (const node of document.querySelectorAll('.js-anthropic')) {
    node.style.display = settings.provider === 'anthropic' ? '' : 'none';
  }
  for (const node of document.querySelectorAll('.js-custom')) {
    node.style.display = isCustom ? '' : 'none';
  }

  const typed = !modelsFor(settings.provider).length;
  $('model').style.display = typed ? 'none' : '';
  $('customModel').style.display = typed ? '' : 'none';
  for (const node of document.querySelectorAll('.js-catalog')) {
    node.style.display = provider.catalogUrl ? '' : 'none';
  }
  if (!typed) {
    const models = modelsFor(settings.provider);
    options($('model'), models.map((m) => m.id), models.map((m) => `${m.label} — ${m.hint}`));
    $('model').value = settings.models[settings.provider] || models[0].id;
  } else {
    $('customModel').value = settings.models[settings.provider] || provider.defaultModel || '';
  }

  $('apiKey').value = settings.keys[settings.provider] || '';
  $('apiKey').placeholder = provider.keyHint;
  $('keyHint').replaceChildren();
  const hint = document.createElement('span');
  hint.textContent =
    settings.provider === 'anthropic'
      ? 'Stored only in this browser profile, sent from the extension’s background worker straight to the API — never to the pages you browse. '
      : 'Stored only in this browser profile and sent only to the endpoint above. ';
  $('keyHint').append(hint);
  if (provider.keysUrl) {
    const link = document.createElement('a');
    link.href = provider.keysUrl;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = 'Get a key';
    $('keyHint').append(link);
  }

  $('providerHint').textContent =
    settings.provider === 'anthropic'
      ? 'Claude models, billed per token by Anthropic.'
      : settings.provider === 'zai'
        ? 'GLM models over Z.ai’s Anthropic-compatible endpoint. Effort, refusal fallbacks and workspace IDs are Anthropic-only and are not sent.'
        : settings.provider === 'openrouter'
          ? 'One key, every model on the gateway — including free ones. Uses OpenRouter’s OpenAI-compatible wire, which works with any model it hosts.'
          : 'Any endpoint implementing either API shape below.';

  checkWorkspaceField();
  checkPermission();
  loadCatalog(settings.provider, false);
  showPrice();
}

/** Accepts a bare ID or anything containing one, e.g. a pasted console URL. */
function normalizeWorkspaceId(value) {
  const match = String(value || '').match(/wrkspc_[A-Za-z0-9]+/);
  return match ? match[0] : String(value || '').trim();
}

function checkWorkspaceField() {
  const status = $('workspaceStatus');
  const value = $('workspaceId').value.trim();
  if (!value || settings.provider !== 'anthropic') {
    status.textContent = '';
    status.className = 'status';
    return;
  }
  const ok = /^wrkspc_[A-Za-z0-9]+$/.test(value);
  status.className = 'status ' + (ok ? 'ok' : 'err');
  status.textContent = ok
    ? 'Looks like a workspace ID.'
    : 'That does not look like a workspace ID (they start with "wrkspc_").';
}

function customOrigin() {
  try {
    return new URL($('customBaseUrl').value.trim()).origin + '/*';
  } catch {
    return null;
  }
}

async function checkPermission() {
  if (settings.provider !== 'custom') return;
  const origin = customOrigin();
  const status = $('grantStatus');
  if (!origin) {
    status.className = 'status';
    status.textContent = '';
    return;
  }
  const granted = await chrome.permissions.contains({ origins: [origin] });
  status.className = 'status ' + (granted ? 'ok' : 'err');
  status.textContent = granted ? 'Access granted.' : 'Chrome needs permission to reach this host.';
}

let saveTimer = null;
function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const provider = $('provider').value;
    const workspaceId = normalizeWorkspaceId($('workspaceId').value);
    if (workspaceId !== $('workspaceId').value.trim()) $('workspaceId').value = workspaceId;

    const patch = {
      provider,
      keys: { [provider]: $('apiKey').value.trim() },
      models: { [provider]: currentModel() },
      customBaseUrl: $('customBaseUrl').value.trim(),
      workspaceId
    };
    for (const id of SIMPLE_FIELDS) patch[id] = $(id).value;
    for (const id of CHECK_FIELDS) patch[id] = $(id).checked;
    for (const id of NUMBER_FIELDS) {
      const value = Number($(id).value);
      patch[id] = Number.isFinite(value) ? value : DEFAULT_SETTINGS[id];
    }
    settings = await saveSettings(patch);
    checkWorkspaceField();
    showPrice();
    $('saveStatus').textContent = 'Saved.';
    setTimeout(() => { $('saveStatus').textContent = ''; }, 1500);
  }, 250);
}

async function init() {
  const ids = Object.keys(PROVIDERS);
  options($('provider'), ids, ids.map((id) => PROVIDERS[id].label));
  options($('effort'), EFFORT_LEVELS);

  settings = await getSettings();
  $('provider').value = settings.provider;
  $('customBaseUrl').value = settings.customBaseUrl || '';
  $('customWire').value = settings.customWire || 'anthropic';
  $('workspaceId').value = settings.workspaceId || '';
  for (const id of SIMPLE_FIELDS) $(id).value = settings[id];
  for (const id of NUMBER_FIELDS) $(id).value = settings[id];
  for (const id of CHECK_FIELDS) $(id).checked = Boolean(settings[id]);
  applyProviderUI();

  $('provider').addEventListener('change', async () => {
    settings = await saveSettings({ provider: $('provider').value });
    applyProviderUI();
  });
  $('model').addEventListener('change', () => { queueSave(); showPrice(); });
  $('customModel').addEventListener('input', () => { queueSave(); showPrice(); });
  $('refreshModels').addEventListener('click', () => loadCatalog(settings.provider, true));
  $('customBaseUrl').addEventListener('input', () => { queueSave(); checkPermission(); });

  for (const id of ['apiKey', 'workspaceId', ...SIMPLE_FIELDS, ...NUMBER_FIELDS, ...CHECK_FIELDS]) {
    $(id).addEventListener('change', queueSave);
    $(id).addEventListener('input', queueSave);
  }

  $('grant').addEventListener('click', async () => {
    const origin = customOrigin();
    if (!origin) {
      $('grantStatus').className = 'status err';
      $('grantStatus').textContent = 'Enter a valid https URL first.';
      return;
    }
    await chrome.permissions.request({ origins: [origin] });
    checkPermission();
  });

  $('reveal').addEventListener('click', () => {
    const field = $('apiKey');
    const hidden = field.type === 'password';
    field.type = hidden ? 'text' : 'password';
    $('reveal').textContent = hidden ? 'Hide' : 'Show';
  });

  $('test').addEventListener('click', async () => {
    const status = $('keyStatus');
    status.className = 'status';
    status.textContent = 'Testing…';
    clearTimeout(saveTimer);
    const provider = $('provider').value;
    settings = await saveSettings({
      provider,
      keys: { [provider]: $('apiKey').value.trim() },
      models: { [provider]: currentModel() },
      customBaseUrl: $('customBaseUrl').value.trim(),
      workspaceId: normalizeWorkspaceId($('workspaceId').value)
    });
    const result = await chrome.runtime.sendMessage({ type: 'test-key' });
    status.className = 'status ' + (result?.ok ? 'ok' : 'err');
    status.textContent = result?.message || 'No response from the extension worker.';
    if (result?.ok && result.workspaceId && !$('workspaceId').value.trim()) {
      $('workspaceId').value = result.workspaceId;
      settings = await saveSettings({ workspaceId: result.workspaceId });
      checkWorkspaceField();
    }
  });

  $('openNotes').addEventListener('click', () =>
    chrome.tabs.create({ url: chrome.runtime.getURL('notes/notes.html') })
  );
  $('shortcutLink').addEventListener('click', () =>
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })
  );
  $('clearHighlights').addEventListener('click', async () => {
    // Each highlight's conversation lives under its own chat:<id> key.
    const chats = Object.keys(await chrome.storage.local.get(null)).filter((key) => key.startsWith('chat:'));
    await chrome.storage.local.remove(chats);
    await chrome.storage.local.set({ highlights: {} });
    $('dataStatus').className = 'status ok';
    $('dataStatus').textContent = 'Highlights cleared. Reload open tabs to see the change.';
  });
  $('clearNotes').addEventListener('click', async () => {
    await chrome.storage.local.set({ notes: [] });
    $('dataStatus').className = 'status ok';
    $('dataStatus').textContent = 'Notes deleted.';
  });
}

init();
