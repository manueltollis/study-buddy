/**
 * Chrome Web Store assets.
 *
 *   node scripts/store-assets.js [outDir]
 *
 * Renders the store icon, the small promo tile and 1280x800 screenshots of
 * the real extension in headless Chrome. API calls are stubbed inside the
 * service worker, so no key or network is needed. Set CHROME_PATH if Chrome
 * is not in the default location.
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(os.homedir(), 'Downloads', 'study-buddy-store'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'study-buddy-assets-'));
const CHROME = process.env.CHROME_PATH || ({
  win32: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
}[process.platform] || 'google-chrome');
const PORT = 9334;
const SITE_PORT = 8766;
const SITE = `http://localhost:${SITE_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ pages */

const FONTS = `
  @font-face { font-family: "SB Display"; src: url("/fonts/bricolage.woff2") format("woff2"); font-weight: 200 800; }
  @font-face { font-family: "SB Sans"; src: url("/fonts/geist.woff2") format("woff2"); font-weight: 100 900; }
  @font-face { font-family: "SB Mono"; src: url("/fonts/geist-mono.woff2") format("woff2"); font-weight: 100 900; }`;

// The brand mark: ink tile, two lines of "text", one swiped with the highlighter.
const MARK = `
  <rect x="4" y="4" width="120" height="120" rx="28" fill="#15142a"/>
  <rect x="26" y="32" width="62" height="7" rx="3.5" fill="#43425c"/>
  <path d="M19 76 L29 52 L110 52 L100 76 Z" fill="#d4ff3a"/>
  <path d="M19 76 L29 52 L33 52 L23 76 Z" fill="#b8e61e"/>
  <rect x="26" y="89" width="76" height="7" rx="3.5" fill="#43425c"/>
  <rect x="26" y="104" width="40" height="7" rx="3.5" fill="#43425c"/>`;

// Store guideline: 128x128 canvas, 96x96 artwork, 16px transparent padding.
const ICON = `<!doctype html><html><body style="margin:0;background:transparent">
  <svg width="128" height="128" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
    <g transform="translate(16 16) scale(0.75)">${MARK}</g>
  </svg></body></html>`;

const PROMO = `<!doctype html><html><head><style>${FONTS}
  body { margin: 0; width: 440px; height: 280px; overflow: hidden; background: #15142a; color: #ecebf4;
    font-family: "SB Sans", sans-serif; position: relative; }
  .grid { position: absolute; inset: 0; background-image: radial-gradient(rgba(236,235,244,0.07) 1px, transparent 1.2px); background-size: 16px 16px; }
  .wrap { position: absolute; left: 36px; top: 44px; right: 36px; }
  svg { display: block; margin-bottom: 22px; }
  h1 { font-family: "SB Display"; font-weight: 780; font-size: 46px; letter-spacing: -0.035em; margin: 0 0 10px; line-height: 1; }
  p { margin: 0; font-size: 17px; line-height: 1.45; color: #b9b8cc; max-width: 330px; }
  .small { margin-top: 8px; font-size: 13.5px; color: #8d8ca3; }
  .swipe { color: #15142a; padding: 0 5px; margin: 0 -2px;
    background: linear-gradient(104deg, transparent 1%, #d4ff3a 3%, #d4ff3a 97%, transparent 99%) 0 55% / 100% 86% no-repeat; }
</style></head><body><div class="grid"></div><div class="wrap">
  <svg width="52" height="52" viewBox="0 0 128 128">${MARK}</svg>
  <h1>Study Buddy</h1>
  <p>Highlight anything. <span class="swipe">Understand it.</span></p>
  <p class="small">Explanations and quizzes on any page or PDF.</p>
</div></body></html>`;

const ARTICLE = `<!doctype html><html><head><meta charset="utf-8"><title>How plants turn light into sugar</title><style>
  body { margin: 0; background: #fbfaf7; color: #22201c; font: 19px/1.7 Georgia, "Times New Roman", serif; }
  nav { height: 56px; border-bottom: 1px solid #e8e4dc; display: flex; align-items: center; padding: 0 48px;
    font: 600 15px system-ui, sans-serif; letter-spacing: 0.02em; color: #3b372f; gap: 28px; }
  nav b { font: 700 18px Georgia, serif; margin-right: auto; }
  article { width: 640px; margin: 44px 0 0 96px; }
  .kicker { font: 600 12px system-ui, sans-serif; letter-spacing: 0.14em; text-transform: uppercase; color: #8a6d3b; }
  h1 { font-size: 40px; line-height: 1.15; margin: 10px 0 14px; letter-spacing: -0.01em; }
  .by { font: 14px system-ui, sans-serif; color: #7b766c; margin-bottom: 26px; }
  p { margin: 0 0 20px; }
</style></head><body>
<nav><b>The Living Cell</b><span>Biology</span><span>Chemistry</span><span>Physics</span></nav>
<article>
  <div class="kicker">Biology · Chapter 8</div>
  <h1>How plants turn light into sugar</h1>
  <div class="by">12 min read · Updated for the 2026 syllabus</div>
  <p id="p1">Photosynthesis is the process by which plants convert light energy into chemical energy stored in glucose. It happens in two linked stages inside the chloroplast.</p>
  <p id="p2">The light-dependent reactions occur in the thylakoid membrane, where chlorophyll absorbs photons and drives the transfer of electrons along an electron transport chain, pumping protons and producing ATP and NADPH.</p>
  <p id="p3">The Calvin cycle then fixes carbon dioxide into three-carbon sugars in the stroma, spending the ATP and NADPH produced by the light reactions. The enzyme Rubisco catalyses its first committed step.</p>
  <p id="p4">Because the two stages are coupled, anything that slows one slows the other: in dim light the Calvin cycle starves for ATP, and without CO₂ the light reactions back up.</p>
</article></body></html>`;

const ANSWERS = {
  explain: `### In plain terms
The **light-dependent reactions** are the part of photosynthesis that captures energy from sunlight.

- **Chlorophyll absorbs a photon**, which knocks an electron into a higher energy level.
- That electron travels down the **electron transport chain**, pumping protons across the thylakoid membrane.
- The proton gradient drives **ATP synthase**, producing ATP, while the electrons end up in **NADPH**.

Those two molecules are the energy currency the Calvin cycle spends to build sugar.`,
  quiz: `1. Where in the chloroplast do the light-dependent reactions happen?
2. Which two molecules do they hand to the Calvin cycle?
3. A plant is kept in bright light but with no CO₂. What happens to ATP and NADPH levels, and why?

---

**Answers**
1. In the **thylakoid membrane**.
2. **ATP and NADPH**.
3. They **build up**: the Calvin cycle can't run without CO₂, so nothing spends them.`
};

const MIME = { '.woff2': 'font/woff2', '.pdf': 'application/pdf' };
const site = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const pages = { '/': ARTICLE, '/icon': ICON, '/promo': PROMO };
  if (pages[url]) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(pages[url]);
  }
  const file = url.endsWith('.pdf') ? path.join(ROOT, 'test', 'fixture.pdf') : path.join(ROOT, url);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
}).listen(SITE_PORT);

/* -------------------------------------------------------------- CDP */

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id); this.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      }
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
  async eval(expression) {
    const out = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || 'eval threw');
    return out.result.value;
  }
}

const targets = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());

async function open(url, width, height, transparent) {
  const target = await fetch(`http://127.0.0.1:${PORT}/json/new?${url}`, { method: 'PUT' }).then((r) => r.json());
  const client = await CDP.connect(target.webSocketDebuggerUrl);
  client.targetId = target.id;
  await client.send('Page.enable');
  await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  // Pin the theme so the system's dark mode doesn't leak into light screenshots.
  await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  if (transparent) await client.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  await sleep(1200);
  return client;
}

async function save(client, name, width, height) {
  const { data } = await client.send('Page.captureScreenshot', {
    format: 'png', clip: { x: 0, y: 0, width, height, scale: 1 }
  });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(data, 'base64'));
  console.log('wrote', path.join(OUT, name));
}

const ROOT_JS = `document.getElementById('claude-study-buddy-root').shadowRoot`;
const select = (id, from, to) => `(() => {
  const node = document.getElementById('${id}').firstChild;
  const start = node.textContent.indexOf(${JSON.stringify(from)});
  const end = node.textContent.indexOf(${JSON.stringify(to)}) + ${JSON.stringify(to)}.length;
  const range = document.createRange();
  range.setStart(node, start); range.setEnd(node, end);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  return sel.toString();
})()`;

/* ------------------------------------------------------------- main */

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--enable-unsafe-extension-debugging', `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`, 'about:blank'
  ], { stdio: 'ignore' });

  for (let i = 0; i < 40; i++) {
    try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(250); }
  }
  const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const browser = await CDP.connect(version.webSocketDebuggerUrl);
  const { id: extId } = await browser.send('Extensions.loadUnpacked', { path: ROOT });

  // The worker target can show up before its extension APIs are bound; wait for chrome.storage.
  let sw = null;
  for (let i = 0; i < 80 && !sw; i++) {
    const target = (await targets()).find((t) => t.type === 'service_worker' && t.url.includes(extId));
    if (target) {
      const client = await CDP.connect(target.webSocketDebuggerUrl);
      if (await client.eval(`typeof chrome !== 'undefined' && Boolean(chrome.storage)`).catch(() => false)) sw = client;
    }
    if (!sw) await sleep(150);
  }
  if (!sw) throw new Error('extension service worker never became ready');
  const heartbeat = setInterval(() => sw.eval('1').catch(() => {}), 4000);

  await sw.eval(`chrome.storage.local.set({ settings: {
    provider: 'anthropic', keys: { anthropic: 'sk-ant-demo' }, models: { anthropic: 'claude-opus-5' },
    effort: 'medium', maxTokens: 1200, level: 'student', contextChars: 800,
    autoHighlight: true, bubbleEnabled: true, useFallbacks: false, showReasoning: false
  } })`);
  await sw.eval(`
    globalThis.__answers = ${JSON.stringify(ANSWERS)};
    globalThis.__realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      if (!String(url).includes('/v1/messages')) return globalThis.__realFetch(url, opts);
      const body = JSON.parse(opts.body);
      const last = JSON.stringify(body.messages[body.messages.length - 1].content);
      const text = /Write 3 questions/.test(last) ? __answers.quiz : __answers.explain;
      const events = [
        { type: 'message_start', message: { id: 'msg_demo', model: body.model, usage: { input_tokens: 486, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 128 } },
        { type: 'message_stop' }
      ];
      const enc = new TextEncoder();
      const nl = String.fromCharCode(10);
      const stream = new ReadableStream({ start(c) {
        for (const e of events) c.enqueue(enc.encode('event: ' + e.type + nl + 'data: ' + JSON.stringify(e) + nl + nl));
        c.close();
      } });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    'stubbed';
  `);

  // 1. Icon and promo tile.
  const icon = await open(`${SITE}/icon`, 128, 128, true);
  await save(icon, 'store-icon-128.png', 128, 128);
  const promo = await open(`${SITE}/promo`, 440, 280, false);
  await save(promo, 'promo-tile-440x280.png', 440, 280);

  // 2. The selection bubble over a fresh selection.
  const page = await open(`${SITE}/`, 1280, 800, false);
  await page.eval(select('p2', 'chlorophyll absorbs', 'NADPH'));
  await sleep(500);
  await save(page, 'screenshot-1-select.png', 1280, 800);

  // 3. The panel with an explanation, passage highlighted in the page.
  await page.eval(`${ROOT_JS}.querySelector('.bubble .primary').click(); 'ok'`);
  await sleep(1500);
  await page.eval(`getSelection().removeAllRanges(); ${ROOT_JS}.querySelector('.thread').scrollTop = 0; 'ok'`);
  await sleep(300);
  await save(page, 'screenshot-2-explain.png', 1280, 800);

  // 4. Quiz mode, dark theme.
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await page.eval(`[...${ROOT_JS}.querySelectorAll('.chip')].find((c) => /quiz/i.test(c.textContent)).click(); 'ok'`);
  await sleep(1500);
  await page.eval(`(() => { const t = ${ROOT_JS}.querySelector('.thread'); t.scrollTop = t.scrollHeight; return 'ok'; })()`);
  await sleep(300);
  await save(page, 'screenshot-3-quiz-dark.png', 1280, 800);

  // 5. PDFs open in the study viewer with the same tools.
  const pdf = await open(`${SITE}/photosynthesis-lecture.pdf`, 1280, 800, false);
  let viewer = null;
  for (let i = 0; i < 60 && !viewer; i++) {
    await sleep(250);
    viewer = (await targets()).find((t) => t.id === pdf.targetId && t.url.includes('/viewer/viewer.html'));
  }
  if (viewer) {
    await sleep(1500);
    await pdf.eval(`(() => {
      const span = [...document.querySelectorAll('.textLayer span')].find((s) => /thylakoid/.test(s.textContent));
      const range = document.createRange(); range.selectNodeContents(span);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return 'ok';
    })()`);
    await sleep(500);
    await pdf.eval(`${ROOT_JS}.querySelector('.bubble .primary').click(); 'ok'`);
    await sleep(1500);
    await pdf.eval(`getSelection().removeAllRanges(); ${ROOT_JS}.querySelector('.thread').scrollTop = 0; 'ok'`);
    await sleep(300);
    await save(pdf, 'screenshot-4-pdf.png', 1280, 800);
  } else {
    console.warn('PDF viewer did not open; skipping the PDF screenshot');
  }

  // 6. Study notes.
  const day = 24 * 3600 * 1000;
  await sw.eval(`chrome.storage.local.set({ notes: [
    { id: 'n1', url: '${SITE}/', title: 'How plants turn light into sugar', selection: 'chlorophyll absorbs photons and drives the transfer of electrons', question: 'Explain', answer: ${JSON.stringify(ANSWERS.explain)}, createdAt: Date.now() - 2 * 3600 * 1000 },
    { id: 'n2', url: 'https://example.org/cell-respiration', title: 'Cellular respiration — Krebs cycle', selection: 'Each turn of the cycle releases two molecules of CO₂', question: 'Key points', answer: '- The Krebs cycle runs in the **mitochondrial matrix**.\\n- Each turn yields **3 NADH, 1 FADH₂ and 1 ATP**.\\n- The carbons leave as CO₂ — the air you breathe out.', createdAt: Date.now() - ${day} }
  ] })`);
  const notes = await open(`chrome-extension://${extId}/notes/notes.html`, 1280, 800, false);
  await sleep(600);
  await save(notes, 'screenshot-5-notes.png', 1280, 800);

  clearInterval(heartbeat);
  chrome.kill();
  site.close();
  await sleep(400);
  try { fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best-effort */ }
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
