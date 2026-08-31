/**
 * End-to-end smoke test.
 *
 *   node test/smoke.js
 *
 * Launches headless Chrome with the extension loaded, stubs the Anthropic
 * endpoint inside the service worker, and drives a real selection -> answer ->
 * highlight -> follow-up flow. No API key and no network calls involved.
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');

const EXT = path.resolve(__dirname, '..');
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-study-'));
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;
const SITE_PORT = 8765;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  \u2014 ' + detail : ''}`); };

const site = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(path.join(__dirname, 'fixture.html')));
}).listen(SITE_PORT);
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id); this.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else this.events.push(msg);
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    return new CDP(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  async eval(expression, awaitPromise = true) {
    const out = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || 'eval threw');
    return out.result.value;
  }
  consoleErrors() {
    return this.events
      .filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
      .map((e) => e.params.args.map((a) => a.value || a.description).join(' '))
      .concat(this.events.filter((e) => e.method === 'Runtime.exceptionThrown')
        .map((e) => e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text));
  }
}

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--enable-unsafe-extension-debugging',
    `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`,
    'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const chromeLog = [];
  chrome.stderr.on('data', (d) => chromeLog.push(String(d)));

  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    try { await fetch(`http://127.0.0.1:${PORT}/json/version`); ready = true; } catch { await sleep(250); }
  }
  check('devtools endpoint up', ready);
  if (!ready) { console.log(chromeLog.join('')); chrome.kill(); site.close(); process.exit(1); }

  // --- load the extension (the --load-extension flag is ignored under remote debugging)
  const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const browser = await CDP.connect(version.webSocketDebuggerUrl);
  const loaded = await browser.send('Extensions.loadUnpacked', { path: EXT });
  check('extension loads unpacked', Boolean(loaded.id), loaded.id);

  // --- service worker
  let swTarget = null;
  for (let i = 0; i < 60 && !swTarget; i++) {
    swTarget = (await targets()).find((t) => t.type === 'service_worker' && t.url.includes('service-worker.js'));
    if (!swTarget) await sleep(100);
  }
  check('extension service worker registered', Boolean(swTarget), swTarget ? swTarget.url.split('/')[2] : chromeLog.join('').slice(-400));
  if (!swTarget) { chrome.kill(); site.close(); process.exit(1); }

  const sw = await CDP.connect(swTarget.webSocketDebuggerUrl);
  await sw.send('Runtime.enable');
  // Keep the worker warm so the fetch stub below survives the whole run.
  const heartbeat = setInterval(() => sw.eval('1').catch(() => {}), 4000);

  // Deliberately the pre-provider settings shape, so this run also covers migration.
  await sw.eval(`chrome.storage.local.set({ settings: { apiKey: 'sk-ant-fake-for-test', model: 'claude-opus-5', effort: 'medium', maxTokens: 1200, level: 'student', contextChars: 800, autoHighlight: true, bubbleEnabled: true, useFallbacks: true, showReasoning: false, workspaceId: 'wrkspc_01TEST' } })`);

  await sw.eval(`
    globalThis.__req = null;
    globalThis.fetch = async (url, opts) => {
      globalThis.__req = { url, headers: opts.headers, body: JSON.parse(opts.body) };
      const events = [
        { type: 'message_start', message: { id: 'msg_x', model: JSON.parse(opts.body).model, usage: { input_tokens: 412, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '**Photosynthesis** converts light into ' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'chemical energy.\\n\\n- Light reactions run in the thylakoid.\\n- The Calvin cycle fixes CO2.' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 64 } },
        { type: 'message_stop' }
      ];
      const enc = new TextEncoder();
      const stream = new ReadableStream({ start(c) {
        for (const e of events) c.enqueue(enc.encode('event: ' + e.type + String.fromCharCode(10) + 'data: ' + JSON.stringify(e) + String.fromCharCode(10, 10)));
        c.close();
      } });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    'stubbed';
  `);

  // --- page
  const created = await fetch(`http://127.0.0.1:${PORT}/json/new?http://localhost:${SITE_PORT}/`, { method: 'PUT' }).then((r) => r.json());
  const page = await CDP.connect(created.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await sleep(1500);

  await page.eval(`
    (() => {
      const node = document.getElementById('p1').firstChild;
      const range = document.createRange();
      range.setStart(node, 88); range.setEnd(node, 210);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return sel.toString();
    })()
  `);
  await sleep(300);

  const mounted = await page.eval(`Boolean(document.getElementById('claude-study-buddy-root') && document.getElementById('claude-study-buddy-root').shadowRoot)`);
  check('content script mounts its shadow-root UI', mounted === true);

  const bubbleOn = await page.eval(`document.getElementById('claude-study-buddy-root').shadowRoot.querySelector('.bubble').classList.contains('bubble--on')`);
  check('selection bubble appears', bubbleOn === true);

  await page.eval(`document.getElementById('claude-study-buddy-root').shadowRoot.querySelector('.bubble .primary').click(); 'clicked'`);

  let answer = '';
  for (let i = 0; i < 40 && !answer.includes('Calvin'); i++) {
    await sleep(200);
    answer = await page.eval(`(document.getElementById('claude-study-buddy-root').shadowRoot.querySelector('.thread .body') || {}).textContent || ''`);
  }
  check('streamed answer rendered in panel', answer.includes('Photosynthesis converts light') && answer.includes('Calvin'), JSON.stringify(answer.slice(0, 70)));

  const markdown = await page.eval(`(() => {
    const body = document.getElementById('claude-study-buddy-root').shadowRoot.querySelector('.thread .body');
    return { strong: body.querySelectorAll('strong').length, li: body.querySelectorAll('li').length, html: body.innerHTML.includes('<strong>') };
  })()`);
  check('markdown rendered as DOM', markdown.strong === 1 && markdown.li === 2, JSON.stringify(markdown));

  const meta = await page.eval(`document.getElementById('claude-study-buddy-root').shadowRoot.querySelector('.thread .meta').textContent`);
  check('usage + cost shown', /412 in \/ 64 out/.test(meta) && /\$0\./.test(meta), JSON.stringify(meta));

  const req = await sw.eval(`JSON.stringify(globalThis.__req && { url: globalThis.__req.url, beta: globalThis.__req.headers['anthropic-beta'], version: globalThis.__req.headers['anthropic-version'], browserHdr: globalThis.__req.headers['anthropic-dangerous-direct-browser-access'], workspace: globalThis.__req.headers['anthropic-workspace-id'], key: globalThis.__req.headers['x-api-key'], model: globalThis.__req.body.model, stream: globalThis.__req.body.stream, effort: globalThis.__req.body.output_config && globalThis.__req.body.output_config.effort, fallbacks: globalThis.__req.body.fallbacks, thinking: globalThis.__req.body.thinking || null, maxTokens: globalThis.__req.body.max_tokens, system: globalThis.__req.body.system[0].text.slice(0, 40), user: globalThis.__req.body.messages[0].content })`);
  const parsed = JSON.parse(req || 'null');
  check('request shape correct', parsed && parsed.url === 'https://api.anthropic.com/v1/messages' && parsed.model === 'claude-opus-5' && parsed.stream === true && parsed.effort === 'medium' && parsed.fallbacks === 'default' && parsed.beta === 'server-side-fallback-2026-07-01' && parsed.version === '2023-06-01' && parsed.browserHdr === 'true' && parsed.thinking === null && parsed.maxTokens === 1200 && parsed.workspace === 'wrkspc_01TEST',
    parsed ? JSON.stringify({ model: parsed.model, effort: parsed.effort, fallbacks: parsed.fallbacks, beta: parsed.beta, thinking: parsed.thinking, max: parsed.maxTokens, workspace: parsed.workspace }) : 'no request captured');
  check('legacy flat settings migrate to the provider shape',
    parsed && parsed.key === 'sk-ant-fake-for-test' && parsed.model === 'claude-opus-5',
    parsed ? `key=${parsed.key ? 'kept' : 'lost'} model=${parsed.model}` : '');
  check('prompt carries passage, context and task', parsed && /Passage the reader highlighted/.test(parsed.user) && /thylakoid membrane/.test(parsed.user) && /Surrounding context/.test(parsed.user) && /Task: Explain what this passage means/.test(parsed.user),
    parsed ? JSON.stringify(parsed.user.slice(0, 90)) : '');

  const hl = await page.eval(`(() => { const m = document.querySelectorAll('mark.claude-study-highlight'); return { count: m.length, text: m.length ? m[0].textContent.slice(0, 30) : '' }; })()`);
  check('passage highlighted in the page', hl.count >= 1, JSON.stringify(hl));

  const stored = await sw.eval(`chrome.storage.local.get('highlights').then(s => JSON.stringify(s.highlights))`);
  check('highlight persisted to storage', stored && stored.includes('thylakoid'), String(stored).slice(0, 120));

  // follow-up question keeps the thread
  await page.eval(`(() => {
    const shadow = document.getElementById('claude-study-buddy-root').shadowRoot;
    const input = shadow.querySelector('.composer textarea');
    input.value = 'What is NADPH doing here?';
    shadow.querySelector('.send').click();
    return 'sent';
  })()`);
  await sleep(1200);
  const followUp = await sw.eval(`JSON.stringify(globalThis.__req.body.messages.map(m => m.role + ':' + m.content.slice(0, 24)))`);
  check('follow-up sends full thread', JSON.parse(followUp).length === 3 && JSON.parse(followUp)[2].startsWith('user:What is NADPH'), followUp);

  // a second action on the same passage continues the thread
  await page.eval(`document.getElementById('claude-study-buddy-root').shadowRoot.querySelectorAll('.chip')[1].click(); 'simpler'`);
  await sleep(1200);
  const midThread = await sw.eval(`JSON.stringify(globalThis.__req.body.messages.map(m => m.role + ':' + m.content.slice(0, 26)))`);
  const midParsed = JSON.parse(midThread);
  check('second action continues the thread', midParsed.length === 5 && /^user:Re-explain this in the s/.test(midParsed[4]), midThread.slice(-70));
  const midError = await page.eval(`(document.getElementById('claude-study-buddy-root').shadowRoot.querySelector('.error') || {}).textContent || ''`);
  check('second action produced no error', midError === '', JSON.stringify(midError));

  // an identity-linked key without a workspace gets an actionable message
  await sw.eval(`
    globalThis.__realStub = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'anthropic-workspace-id is required when authenticating with an identity-linked API key; send the id of the workspace this request acts in.' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    'stubbed-400'`);
  await page.eval(`document.getElementById('claude-study-buddy-root').shadowRoot.querySelectorAll('.chip')[2].click(); 'keypoints'`);
  await sleep(1000);
  const wsError = await page.eval(`(document.getElementById('claude-study-buddy-root').shadowRoot.querySelector('.error') || {}).textContent || ''`);
  check('workspace-required error is actionable', /workspace ID \(wrkspc/.test(wsError) && /Settings → Workspaces/.test(wsError) && /Open settings/.test(wsError), JSON.stringify(wsError.slice(0, 90)));
  await sw.eval(`globalThis.fetch = globalThis.__realStub; 'restored'`);

  // switching provider retargets the endpoint and drops Anthropic-only fields
  await sw.eval(`chrome.storage.local.set({ settings: { provider: 'zai', keys: { zai: 'zai-test-key' }, models: { zai: 'glm-5.3-flash' }, effort: 'medium', maxTokens: 1200, level: 'student', contextChars: 800, autoHighlight: false, bubbleEnabled: true, useFallbacks: true, workspaceId: 'wrkspc_01TEST' } })`);
  await sleep(300);
  await page.eval(`document.getElementById('claude-study-buddy-root').shadowRoot.querySelectorAll('.chip')[3].click(); 'example'`);
  await sleep(1200);
  const glm = JSON.parse(await sw.eval(`JSON.stringify({
    url: globalThis.__req.url,
    model: globalThis.__req.body.model,
    bearer: globalThis.__req.headers.authorization,
    key: globalThis.__req.headers['x-api-key'],
    effort: globalThis.__req.body.output_config || null,
    fallbacks: globalThis.__req.body.fallbacks || null,
    beta: globalThis.__req.headers['anthropic-beta'] || null,
    workspace: globalThis.__req.headers['anthropic-workspace-id'] || null,
    stream: globalThis.__req.body.stream
  })`));
  check('GLM provider targets the Z.ai Anthropic endpoint',
    glm.url === 'https://api.z.ai/api/anthropic/v1/messages' && glm.model === 'glm-5.3-flash' &&
    glm.bearer === 'Bearer zai-test-key' && glm.key === 'zai-test-key' && glm.stream === true,
    JSON.stringify({ url: glm.url, model: glm.model, bearer: Boolean(glm.bearer) }));
  check('Anthropic-only fields are not sent to GLM',
    glm.effort === null && glm.fallbacks === null && glm.beta === null && glm.workspace === null,
    JSON.stringify({ effort: glm.effort, fallbacks: glm.fallbacks, beta: glm.beta, workspace: glm.workspace }));
  const glmMeta = await page.eval(`[...document.getElementById('claude-study-buddy-root').shadowRoot.querySelectorAll('.thread .meta')].pop().textContent`);
  check('GLM cost readout uses GLM prices', /glm-5\.3-flash/.test(glmMeta) && /\$0\.00004/.test(glmMeta), JSON.stringify(glmMeta.slice(0, 60)));

  // OpenRouter: the OpenAI Chat Completions wire
  await sw.eval(`chrome.storage.local.set({ settings: { provider: 'openrouter', keys: { openrouter: 'sk-or-test' }, models: { openrouter: 'z-ai/glm-5.3-flash' }, prices: { 'z-ai/glm-5.3-flash': [0.075, 0.25] }, maxTokens: 1200, level: 'student', contextChars: 800, autoHighlight: false, bubbleEnabled: true, effort: 'medium', useFallbacks: true, workspaceId: 'wrkspc_01TEST' } })`);
  await sw.eval(`
    globalThis.__anthropicStub = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      globalThis.__req = { url, headers: opts.headers, body: JSON.parse(opts.body) };
      const events = [
        { model: 'z-ai/glm-5.3-flash', choices: [{ delta: { role: 'assistant', content: 'Via OpenRouter: ' }, finish_reason: null }] },
        { model: 'z-ai/glm-5.3-flash', choices: [{ delta: { content: '**ATP** powers the Calvin cycle.' }, finish_reason: 'stop' }] },
        { model: 'z-ai/glm-5.3-flash', choices: [], usage: { prompt_tokens: 900, completion_tokens: 150 } }
      ];
      const enc = new TextEncoder();
      return new Response(new ReadableStream({ start(c) {
        for (const e of events) c.enqueue(enc.encode('data: ' + JSON.stringify(e) + String.fromCharCode(10, 10)));
        c.enqueue(enc.encode('data: [DONE]' + String.fromCharCode(10, 10)));
        c.close();
      } }), { status: 200 });
    }; 'openai-stub'`);
  await sleep(300);
  await page.eval(`document.getElementById('claude-study-buddy-root').shadowRoot.querySelectorAll('.chip')[4].click(); 'terms'`);
  await sleep(1500);
  const or = JSON.parse(await sw.eval(`JSON.stringify({
    url: globalThis.__req.url,
    model: globalThis.__req.body.model,
    firstRole: globalThis.__req.body.messages[0].role,
    turns: globalThis.__req.body.messages.length,
    hasSystemField: 'system' in globalThis.__req.body,
    usageOpt: globalThis.__req.body.stream_options && globalThis.__req.body.stream_options.include_usage,
    bearer: globalThis.__req.headers.authorization,
    anthropicHeaders: Object.keys(globalThis.__req.headers).filter(h => h.startsWith('anthropic')).length
  })`));
  check('OpenRouter uses the OpenAI wire',
    or.url === 'https://openrouter.ai/api/v1/chat/completions' && or.model === 'z-ai/glm-5.3-flash' &&
    or.firstRole === 'system' && or.hasSystemField === false && or.usageOpt === true &&
    or.bearer === 'Bearer sk-or-test' && or.anthropicHeaders === 0,
    JSON.stringify(or));
  const orBody = await page.eval(`[...document.getElementById('claude-study-buddy-root').shadowRoot.querySelectorAll('.thread .body')].pop().textContent`);
  const orMeta = await page.eval(`[...document.getElementById('claude-study-buddy-root').shadowRoot.querySelectorAll('.thread .meta')].pop().textContent`);
  check('OpenAI-wire stream renders and prices',
    /Via OpenRouter: ATP powers the Calvin cycle\./.test(orBody) && /900 in \/ 150 out/.test(orMeta) && /\$0\.000/.test(orMeta),
    JSON.stringify(orBody.slice(0, 45) + ' | ' + orMeta.slice(0, 55)));
  await sw.eval(`globalThis.fetch = globalThis.__anthropicStub; 'restored'`);

  // back to Anthropic for the remaining checks
  await sw.eval(`chrome.storage.local.set({ settings: { provider: 'anthropic', keys: { anthropic: 'sk-ant-fake-for-test' }, models: { anthropic: 'claude-opus-5' }, effort: 'medium', maxTokens: 1200, level: 'student', contextChars: 800, autoHighlight: true, bubbleEnabled: true, useFallbacks: true } })`);
  await sleep(300);

  // reload restores highlights
  await page.send('Page.navigate', { url: `http://localhost:${SITE_PORT}/` });
  await sleep(2000);
  const restored = await page.eval(`document.querySelectorAll('mark.claude-study-highlight').length`);
  check('highlights restored after reload', restored >= 1, `marks=${restored}`);

  // long selection exposes the quote expander
  await page.eval(`(() => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('p1'));
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  })()`);
  await sleep(400);
  await page.eval(`document.getElementById('claude-study-buddy-root').shadowRoot.querySelectorAll('.bubble button')[3].click(); 'panel'`);
  await sleep(300);
  const quoteState = await page.eval(`(() => {
    const s = document.getElementById('claude-study-buddy-root').shadowRoot;
    const toggle = s.querySelector('.quote button');
    const before = toggle.style.display !== 'none';
    toggle.click();
    return before + ':' + s.querySelector('.quote').classList.contains('open') + ':' + toggle.textContent;
  })()`);
  check('long quote gets an expander', quoteState === 'true:true:Show less', quoteState);

  // a typed question with no action at all
  await page.eval(`(() => {
    const node = document.getElementById('p2').firstChild;
    const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, 96);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  })()`);
  await sleep(400);
  await page.eval(`document.getElementById('claude-study-buddy-root').shadowRoot.querySelectorAll('.bubble button')[3].click(); 'ask'`);
  await sleep(200);
  const focused = await page.eval(`(() => { const s = document.getElementById('claude-study-buddy-root').shadowRoot;
    return s.activeElement === s.querySelector('.composer textarea'); })()`);
  check('"Ask…" opens the panel with the question box focused', focused === true);
  await page.eval(`(() => { const s = document.getElementById('claude-study-buddy-root').shadowRoot;
    s.querySelector('.composer textarea').value = 'Why does the cycle need ATP and NADPH specifically?';
    s.querySelector('.send').click(); })()`);
  await sleep(1200);
  const custom = await sw.eval(`JSON.stringify({ n: globalThis.__req.body.messages.length, text: globalThis.__req.body.messages[0].content })`);
  const customParsed = JSON.parse(custom);
  check('custom question is asked against the passage',
    customParsed.n === 1 && /Passage the reader highlighted/.test(customParsed.text) && /Task: Why does the cycle need ATP and NADPH specifically\?/.test(customParsed.text),
    JSON.stringify(customParsed.text.slice(-80)));
  const customTurn = await page.eval(`document.getElementById('claude-study-buddy-root').shadowRoot.querySelector('.turn--user').textContent`);
  check('custom question shows in the thread', customTurn === 'Why does the cycle need ATP and NADPH specifically?', JSON.stringify(customTurn));

  // error path: no key
  await sw.eval(`chrome.storage.local.set({ settings: { provider: 'anthropic', keys: { anthropic: '' }, models: { anthropic: 'claude-opus-5' }, effort: 'medium', bubbleEnabled: true, autoHighlight: false } })`);
  await sleep(300);
  await page.eval(`(() => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('p2'));
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return 'selected';
  })()`);
  await sleep(400);
  await page.eval(`document.getElementById('claude-study-buddy-root').shadowRoot.querySelector('.bubble .primary').click(); 'clicked'`);
  await sleep(1000);
  const errText = await page.eval(`(document.getElementById('claude-study-buddy-root').shadowRoot.querySelector('.error') || {}).textContent || ''`);
  check('missing key surfaces a fixable error', errText.includes('No API key') && errText.includes('Open settings'), JSON.stringify(errText));

  // --- extension pages
  const extId = loaded.id;
  for (const [name, path, probe, expect] of [
    ['options page', 'options/options.html', `document.getElementById('provider').options.length + ':' + document.getElementById('model').options.length + ':' + document.getElementById('effort').options.length + ':' + /questions per \\$1/.test(document.getElementById('priceHint').textContent)`, '4:3:5:true'],
    ['notes page', 'notes/notes.html', `document.querySelectorAll('.card').length + ':' + (document.querySelector('.answer strong') ? 'md' : 'nomd')`, '1:md'],
    ['popup', 'popup/popup.html', `document.querySelectorAll('button').length > 4 ? 'ok' : 'thin'`, 'ok']
  ]) {
    if (name === 'notes page') {
      await sw.eval(`chrome.storage.local.set({ notes: [{ id: 'n1', url: 'http://localhost:8765/', title: 'Photosynthesis', selection: 'light-dependent reactions', question: 'Explain', answer: '**Light** reactions make ATP.', createdAt: Date.now() }] })`);
    }
    const target = await fetch(`http://127.0.0.1:${PORT}/json/new?chrome-extension://${extId}/${path}`, { method: 'PUT' }).then((r) => r.json());
    const client = await CDP.connect(target.webSocketDebuggerUrl);
    await client.send('Runtime.enable');
    await sleep(900);
    let value = 'threw';
    try { value = String(await client.eval(probe)); } catch (err) { value = 'threw: ' + err.message.slice(0, 80); }
    const errs = client.consoleErrors();
    check(`${name} renders`, value === expect && errs.length === 0, `got ${value}, expected ${expect}${errs.length ? ' | errors: ' + errs.join(' | ').slice(0, 200) : ''}`);
    await fetch(`http://127.0.0.1:${PORT}/json/close/${target.id}`);
  }

  const pageErrors = page.consoleErrors().filter((e) => !/favicon/i.test(e));
  const swErrors = sw.consoleErrors();
  check('no console errors in page', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300));
  check('no console errors in worker', swErrors.length === 0, swErrors.join(' | ').slice(0, 300));

  console.log('\n' + results.filter((r) => r.pass).length + '/' + results.length + ' checks passed');
  clearInterval(heartbeat);
  chrome.kill();
  site.close();
  await sleep(400);
  try { fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 3 }); } catch { /* profile cleanup is best-effort */ }
  process.exit(results.every((r) => r.pass) ? 0 : 1);
})().catch((err) => { console.error('HARNESS ERROR', err); process.exit(2); });
