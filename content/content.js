/**
 * Content script: selection bubble, study panel, and persistent highlights.
 *
 * All UI lives in a shadow root so page CSS cannot reach it, and every node is
 * built with DOM APIs (never innerHTML) so model output stays inert.
 */
(function () {
  if (window.__claudeStudyBuddyLoaded) return;
  window.__claudeStudyBuddyLoaded = true;

  const HOST_ID = 'claude-study-buddy-root';
  const HL_CLASS = 'claude-study-highlight';
  const PORT_NAME = 'claude-study';

  const ACTION_LABELS = {
    explain: 'Explain',
    simplify: 'Simpler',
    keypoints: 'Key points',
    example: 'Example',
    terms: 'Define terms',
    quiz: 'Quiz me',
    pageSummary: 'Summarize page',
    pageQuiz: 'Quiz me on the page'
  };
  const PANEL_ACTIONS = ['explain', 'simplify', 'keypoints', 'example', 'terms', 'quiz'];

  const settings = {
    bubbleEnabled: true,
    autoHighlight: true,
    contextChars: 1500
  };

  const state = {
    host: null,
    shadow: null,
    panel: null,
    bubble: null,
    pending: null, // { text, range, rect }
    subject: null, // { text, context, highlightId, isPage }
    thread: [], // API-shaped history
    requestId: 0,
    port: null,
    streaming: false,
    current: null // { bodyEl, buffer, metaEl, turnEl }
  };

  /* ------------------------------------------------------------- helpers */

  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
        else node.setAttribute(key, value);
      }
    }
    for (const child of [].concat(children || [])) {
      if (child) node.appendChild(child);
    }
    return node;
  }

  const normalize = (text) => String(text || '').replace(/\s+/g, ' ').trim();

  /**
   * The URL of the document being read. In the PDF study viewer the tab's own
   * URL is the viewer page, so notes and highlights key off the PDF instead.
   */
  function docUrl() {
    if (location.protocol === 'chrome-extension:') {
      const file = new URLSearchParams(location.search).get('file');
      if (file) return file;
    }
    return location.href;
  }

  const pageKey = () => {
    const url = docUrl();
    if (url !== location.href) return url.split('#')[0];
    return location.origin + location.pathname;
  };

  function loadSettings() {
    chrome.storage.local.get('settings', (stored) => {
      if (chrome.runtime.lastError) return;
      Object.assign(settings, stored.settings || {});
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) Object.assign(settings, changes.settings.newValue || {});
  });

  /* ------------------------------------------------------ text indexing */

  /**
   * Snapshot of every visible text node plus a whitespace-normalized
   * projection of the page, so a highlight can be found again on reload even
   * though the DOM offsets will have changed.
   */
  function buildTextIndex() {
    const nodes = [];
    const starts = [];
    let full = '';
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || !node.nodeValue) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA') {
          return NodeFilter.FILTER_REJECT;
        }
        if (parent.closest('#' + HOST_ID)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let node;
    while ((node = walker.nextNode())) {
      nodes.push(node);
      starts.push(full.length);
      full += node.nodeValue;
    }

    let norm = '';
    const map = [];
    let prevSpace = true;
    for (let i = 0; i < full.length; i += 1) {
      const ch = full[i];
      if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === '\f' || ch === ' ') {
        if (prevSpace) continue;
        norm += ' ';
        map.push(i);
        prevSpace = true;
      } else {
        norm += ch;
        map.push(i);
        prevSpace = false;
      }
    }
    return { nodes, starts, full, norm, map };
  }

  function nodeIndexAt(index, fullOffset) {
    let lo = 0;
    let hi = index.starts.length - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (index.starts[mid] <= fullOffset) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }

  function normIndexOfFull(index, fullOffset) {
    let lo = 0;
    let hi = index.map.length - 1;
    let best = index.map.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (index.map[mid] >= fullOffset) {
        best = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    return best;
  }

  function fullOffsetOfPoint(index, container, offset) {
    if (container.nodeType === Node.TEXT_NODE) {
      const at = index.nodes.indexOf(container);
      return at === -1 ? null : index.starts[at] + offset;
    }
    const child = container.childNodes[offset] || container.lastChild;
    if (!child) return null;
    const walker = document.createTreeWalker(child, NodeFilter.SHOW_TEXT);
    const first = walker.nextNode();
    if (!first) return null;
    const at = index.nodes.indexOf(first);
    return at === -1 ? null : index.starts[at];
  }

  /** Maps a [start, end) range in the normalized string back to a DOM Range. */
  function rangeFromNorm(index, normStart, normEnd) {
    if (normStart < 0 || normEnd > index.map.length || normEnd <= normStart) return null;
    const fullStart = index.map[normStart];
    const fullEnd = index.map[normEnd - 1] + 1;
    const startNode = nodeIndexAt(index, fullStart);
    const endNode = nodeIndexAt(index, fullEnd - 1);
    const range = document.createRange();
    try {
      range.setStart(index.nodes[startNode], fullStart - index.starts[startNode]);
      range.setEnd(index.nodes[endNode], fullEnd - index.starts[endNode]);
    } catch {
      return null;
    }
    return range;
  }

  /* --------------------------------------------------------- highlights */

  function wrapRange(range, id) {
    const targets = [];
    const walker = document.createTreeWalker(
      range.commonAncestorContainer.nodeType === Node.TEXT_NODE
        ? range.commonAncestorContainer.parentNode
        : range.commonAncestorContainer,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent || parent.closest('#' + HOST_ID)) return NodeFilter.FILTER_REJECT;
          if (parent.tagName === 'SCRIPT' || parent.tagName === 'STYLE') return NodeFilter.FILTER_REJECT;
          return range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      }
    );
    let node;
    while ((node = walker.nextNode())) targets.push(node);
    if (!targets.length && range.startContainer.nodeType === Node.TEXT_NODE) {
      targets.push(range.startContainer);
    }

    const marks = [];
    for (const target of targets) {
      let start = target === range.startContainer ? range.startOffset : 0;
      let end = target === range.endContainer ? range.endOffset : target.nodeValue.length;
      if (end <= start) continue;
      let piece = target;
      if (start > 0) piece = piece.splitText(start);
      if (end - start < piece.nodeValue.length) piece.splitText(end - start);
      const mark = document.createElement('mark');
      mark.className = HL_CLASS;
      mark.dataset.hlId = id;
      piece.parentNode.insertBefore(mark, piece);
      mark.appendChild(piece);
      marks.push(mark);
    }
    return marks;
  }

  async function storedHighlights() {
    const store = await chrome.storage.local.get('highlights');
    const all = store.highlights || {};
    return { all, list: all[pageKey()] || [] };
  }

  async function persistHighlight(entry) {
    const { all, list } = await storedHighlights();
    all[pageKey()] = [...list.filter((h) => h.id !== entry.id), entry].slice(-200);
    await chrome.storage.local.set({ highlights: all });
  }

  async function forgetHighlight(id) {
    const { all, list } = await storedHighlights();
    all[pageKey()] = list.filter((h) => h.id !== id);
    await chrome.storage.local.set({ highlights: all });
    for (const mark of document.querySelectorAll(`mark.${HL_CLASS}[data-hl-id="${id}"]`)) {
      const parent = mark.parentNode;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    }
  }

  /** Creates a highlight from a live range and remembers it for this URL. */
  function createHighlight(range, text) {
    const target = normalize(text);
    if (!target || target.length < 2) return null;
    const index = buildTextIndex();
    const fullStart = fullOffsetOfPoint(index, range.startContainer, range.startOffset);
    const normStart = fullStart === null ? -1 : normIndexOfFull(index, fullStart);

    let occurrence = 0;
    let cursor = 0;
    let found;
    while ((found = index.norm.indexOf(target, cursor)) !== -1) {
      if (normStart >= 0 && found >= normStart) break;
      occurrence += 1;
      cursor = found + 1;
    }

    const id = 'hl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const marks = wrapRange(range, id);
    if (!marks.length) return null;
    const entry = { id, text: target, occurrence, createdAt: Date.now(), title: document.title };
    persistHighlight(entry);
    return entry;
  }

  function restoreHighlight(entry) {
    if (document.querySelector(`mark.${HL_CLASS}[data-hl-id="${entry.id}"]`)) return true;
    const index = buildTextIndex();
    let at = -1;
    let cursor = 0;
    for (let n = 0; n <= entry.occurrence; n += 1) {
      at = index.norm.indexOf(entry.text, cursor);
      if (at === -1) break;
      cursor = at + 1;
    }
    if (at === -1) at = index.norm.indexOf(entry.text);
    if (at === -1) return false;
    const range = rangeFromNorm(index, at, at + entry.text.length);
    if (!range) return false;
    return wrapRange(range, entry.id).length > 0;
  }

  async function restoreAll() {
    const { list } = await storedHighlights();
    for (const entry of list) {
      try {
        restoreHighlight(entry);
      } catch {
        /* page changed too much - skip this one */
      }
    }
  }

  /* ------------------------------------------------- selection plumbing */

  function contextAround(range, text) {
    const budget = Math.max(200, Number(settings.contextChars) || 1500);
    let node = range.commonAncestorContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    let scope = node;
    let best = '';
    for (let depth = 0; depth < 6 && scope; depth += 1, scope = scope.parentElement) {
      const raw = scope.textContent || '';
      if (raw.length > 60000) break;
      best = raw;
      if (raw.length >= text.length + budget) break;
    }
    const haystack = normalize(best);
    const needle = normalize(text);
    if (!haystack || haystack === needle) return '';
    const at = haystack.indexOf(needle.slice(0, 60));
    const from = at < 0 ? 0 : Math.max(0, at - Math.floor(budget / 2));
    return haystack.slice(from, from + needle.length + budget).trim();
  }

  function readSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    const anchor = selection.anchorNode;
    const anchorEl = anchor && anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor;
    if (anchorEl && anchorEl.closest && anchorEl.closest('#' + HOST_ID)) return null;
    const text = selection.toString();
    if (normalize(text).length < 2) return null;
    const rect = range.getBoundingClientRect();
    return { text, range: range.cloneRange(), rect };
  }

  function pageText(limit = 18000) {
    // The PDF viewer can hand over every page's text, including unrendered ones.
    if (typeof window.__claudeStudyPageText === 'function') {
      const extracted = window.__claudeStudyPageText();
      if (extracted) return String(extracted).slice(0, limit);
    }
    const main = document.querySelector('main, article, [role="main"]') || document.body;
    const text = (main.innerText || main.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
    return text.slice(0, limit);
  }

  /* ---------------------------------------------------------------- UI */

  const STYLES = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: var(--font-sans); }
    ::selection { background: var(--marker-soft); }

    /* Floating selection toolbar: always ink, whatever the page. */
    .bubble {
      position: fixed; z-index: 2147483647; display: flex; align-items: center; gap: 1px;
      padding: 4px; background: #15142a; border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px; box-shadow: 0 10px 30px -8px rgba(10, 10, 25, 0.5), 0 2px 6px rgba(10, 10, 25, 0.2);
      opacity: 0; transform: translateY(6px) scale(0.97); transform-origin: 50% 100%; pointer-events: none;
      transition: opacity 140ms ease, transform 180ms cubic-bezier(.2, .9, .3, 1.3);
    }
    .bubble--on { opacity: 1; transform: none; pointer-events: auto; }
    .bubble button {
      border: 0; background: transparent; color: #d9d8e6; font-size: 12.5px; font-weight: 500;
      padding: 6px 10px; border-radius: 8px; cursor: pointer; white-space: nowrap;
    }
    .bubble button:hover { background: rgba(255, 255, 255, 0.09); color: #fff; }
    .bubble .primary { background: #d4ff3a; color: #15142a; font-weight: 650; }
    .bubble .primary:hover { background: #e2ff72; color: #15142a; }

    .panel {
      position: fixed; z-index: 2147483646; top: 76px; right: 20px;
      width: 392px; min-width: 300px; max-width: 90vw; height: 540px; min-height: 240px;
      max-height: calc(100vh - 110px); display: none; flex-direction: column; overflow: hidden;
      background: var(--surface); color: var(--text); border: 1px solid var(--line);
      border-radius: 16px; resize: both;
      box-shadow: 0 28px 60px -18px rgba(10, 10, 25, 0.45), 0 4px 14px rgba(10, 10, 25, 0.1);
    }
    .panel--on { display: flex; animation: pop 220ms cubic-bezier(.2, .9, .3, 1.15); }
    @keyframes pop { from { opacity: 0; transform: translateY(8px) scale(0.98); } }

    .head { display: flex; align-items: center; gap: 10px; padding: 12px 12px 10px 16px; cursor: grab; user-select: none; }
    .head:active { cursor: grabbing; }
    /* Brand mark: a chisel-tip highlighter swipe. */
    .dot {
      width: 18px; height: 11px; flex: none; background: var(--marker);
      border-radius: 3px 1px 3px 1px; transform: skewX(-18deg) rotate(-6deg);
    }
    .title {
      font-family: var(--font-display); font-size: 15px; font-weight: 750; letter-spacing: -0.02em; flex: 1;
      font-variation-settings: "opsz" 32;
    }
    .icon-btn { border: 0; background: transparent; color: var(--muted); cursor: pointer; font-size: 13px; padding: 5px 8px; border-radius: 7px; }
    .icon-btn:hover { background: var(--hover); color: var(--text); }

    /* The passage, shown as if swiped with the highlighter. */
    .quote { margin: 0 12px; padding: 11px 13px; border-radius: 11px; background: var(--quote-bg); }
    .quote p { margin: 0; font-size: 12.5px; line-height: 1.7; color: var(--text); max-height: 64px; overflow: hidden; }
    .quote p span {
      background: linear-gradient(104deg, transparent 0.5%, var(--marker-soft) 1.5%, var(--marker-soft) 98.5%, transparent 99.5%) 0 58% / 100% 76% no-repeat;
      -webkit-box-decoration-break: clone; box-decoration-break: clone; padding: 0 2px;
    }
    .quote.open p { max-height: 340px; overflow: auto; }
    .quote button {
      margin-top: 7px; border: 0; background: transparent; color: var(--muted); cursor: pointer; padding: 0;
      font: 500 10.5px var(--font-mono); text-transform: uppercase; letter-spacing: 0.1em;
    }
    .quote button:hover { color: var(--text); }

    .chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 12px; border-bottom: 1px solid var(--line); }
    .chip {
      border: 1px solid var(--line-strong); background: transparent; color: var(--text); font-size: 12px; font-weight: 500;
      padding: 5px 11px; border-radius: 8px; cursor: pointer; transition: background 120ms ease, border-color 120ms ease, transform 80ms ease;
    }
    .chip:hover { background: var(--marker); border-color: var(--marker); color: #15142a; }
    .chip:active { transform: translateY(1px); }

    .thread { flex: 1; overflow-y: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 14px; }
    .turn { font-size: 13.5px; line-height: 1.62; }
    .turn--user {
      align-self: flex-start; color: var(--text); font-size: 12px; font-weight: 600;
      background: var(--quote-bg); border-radius: 8px; padding: 5px 10px;
    }
    .turn--user::before { content: "Q"; font: 600 10px var(--font-mono); color: var(--faint); margin-right: 7px; }
    .body > *:first-child { margin-top: 0; }
    .body > *:last-child { margin-bottom: 0; }
    .body p, .body ul, .body ol, .body blockquote, .body pre { margin: 0 0 9px; }
    .body ul, .body ol { padding-left: 20px; }
    .body li { margin-bottom: 4px; }
    .body li::marker { color: var(--faint); }
    .body strong { font-weight: 650; background: linear-gradient(transparent 62%, var(--marker-soft) 62%); }
    .body h3, .body h4, .body h5, .body h6 { margin: 14px 0 6px; font-family: var(--font-display); font-size: 14px; font-weight: 700; letter-spacing: -0.01em; }
    .body code { font-family: var(--font-mono); font-size: 12px; background: var(--code-bg); padding: 1px 4px; border-radius: 4px; }
    .body pre { background: var(--code-bg); padding: 9px 10px; border-radius: 9px; overflow-x: auto; }
    .body pre code { background: none; padding: 0; }
    .body blockquote { border-left: 2px solid var(--line-strong); padding-left: 10px; color: var(--muted); }
    .body a { color: var(--accent); }
    .body hr { border: 0; border-top: 1px dashed var(--line-strong); margin: 12px 0; }

    .thinking {
      font-size: 12px; color: var(--muted); border-left: 2px dashed var(--line-strong); padding-left: 10px;
      margin-bottom: 8px; white-space: pre-wrap; max-height: 120px; overflow-y: auto;
    }
    .meta { display: flex; align-items: center; gap: 8px; margin-top: 10px; font: 10.5px var(--font-mono); color: var(--faint); }
    .meta button {
      border: 1px solid var(--line); background: transparent; color: var(--muted); font: 500 10.5px var(--font-mono);
      cursor: pointer; padding: 2px 7px; border-radius: 6px;
    }
    .meta button:hover { border-color: var(--text); color: var(--text); }
    .notice { font-size: 12px; color: var(--muted); background: var(--quote-bg); border-radius: 9px; padding: 8px 10px; }
    .error { font-size: 12.5px; color: var(--danger); background: var(--danger-bg); border-radius: 9px; padding: 9px 11px; line-height: 1.5; }
    .error button { display: block; margin-top: 7px; border: 0; background: var(--danger); color: #fff; font-size: 12px; padding: 5px 10px; border-radius: 7px; cursor: pointer; }
    .cursor::after {
      content: ""; display: inline-block; width: 7px; height: 1em; margin-left: 2px; vertical-align: -2px;
      background: var(--marker); border-radius: 1px; transform: skewX(-12deg); animation: blink 0.9s steps(2) infinite;
    }
    @keyframes blink { 50% { opacity: 0; } }
    .empty { color: var(--faint); font-size: 12.5px; line-height: 1.6; }

    .composer { display: flex; gap: 8px; padding: 10px 12px 12px; border-top: 1px solid var(--line); align-items: flex-end; }
    .composer textarea {
      flex: 1; resize: none; border: 1px solid var(--line-strong); border-radius: 10px; padding: 9px 11px;
      font-size: 13px; line-height: 1.4; color: var(--text); background: var(--input-bg); max-height: 110px; min-height: 38px;
      transition: border-color 120ms ease, box-shadow 120ms ease;
    }
    .composer textarea::placeholder { color: var(--faint); }
    .composer textarea:focus { outline: none; border-color: var(--text); box-shadow: 0 0 0 3px var(--marker-soft); }
    .send {
      border: 0; background: var(--primary-bg); color: var(--primary-ink); font-size: 12.5px; font-weight: 650;
      padding: 10px 15px; border-radius: 10px; cursor: pointer; transition: filter 120ms ease, transform 80ms ease;
    }
    .send:hover { filter: brightness(1.12); }
    .send:active { transform: translateY(1px); }
    .send--stop { background: var(--muted); color: var(--surface); }

    :host {
      --font-display: "SB Display", "SB Sans", system-ui, sans-serif;
      --font-sans: "SB Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
      --font-mono: "SB Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
      --marker: #d4ff3a; --marker-soft: rgba(212, 255, 58, 0.6);
      --surface: #ffffff; --text: #15142a; --muted: #5c5b73; --faint: #9a98ac;
      --line: #e9e8ef; --line-strong: #d4d3de; --hover: #f1f0f5; --quote-bg: #f5f4ee; --code-bg: #f1f0f5;
      --input-bg: #ffffff; --accent: #2c46ef; --primary-bg: #15142a; --primary-ink: #d4ff3a;
      --danger: #d02f4a; --danger-bg: #fdeef1;
    }
    @media (prefers-color-scheme: dark) {
      :host {
        --marker-soft: rgba(212, 255, 58, 0.3);
        --surface: #14141f; --text: #ecebf4; --muted: #a3a2b8; --faint: #6d6c84;
        --line: #262636; --line-strong: #37374b; --hover: #1d1d2b; --quote-bg: #1b1b28; --code-bg: #1d1d2b;
        --input-bg: #101019; --accent: #d4ff3a; --primary-bg: #d4ff3a; --primary-ink: #15142a;
        --danger: #ff7a8e; --danger-bg: #331820;
      }
    }
  `;

  function mount() {
    if (state.host) return;
    const host = el('div', { id: HOST_ID });
    host.style.cssText = 'all: initial; position: static;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.appendChild(el('style', { text: STYLES }));

    const bubble = el('div', { class: 'bubble' }, [
      el('button', {
        class: 'primary',
        text: 'Explain',
        onclick: () => { adoptPending(); ask({ action: 'explain' }); }
      }),
      el('button', { text: 'Simpler', onclick: () => { adoptPending(); ask({ action: 'simplify' }); } }),
      el('button', { text: 'Quiz', onclick: () => { adoptPending(); ask({ action: 'quiz' }); } }),
      el('button', {
        text: 'Ask…',
        title: 'Ask your own question about this passage',
        onclick: () => { adoptPending(); openPanel({ focus: true }); }
      })
    ]);
    bubble.addEventListener('mousedown', (event) => event.preventDefault());

    const quoteText = el('p');
    const quoteToggle = el('button', { text: 'Show all', onclick: () => {
      quote.classList.toggle('open');
      quoteToggle.textContent = quote.classList.contains('open') ? 'Show less' : 'Show all';
    } });
    const quote = el('blockquote', { class: 'quote' }, [quoteText, quoteToggle]);

    const chips = el('div', { class: 'chips' },
      PANEL_ACTIONS.map((action) =>
        el('button', { class: 'chip', text: ACTION_LABELS[action], onclick: () => ask({ action }) })
      )
    );

    const thread = el('div', { class: 'thread' });
    const input = el('textarea', { rows: '1', placeholder: 'Ask your own question about this passage…' });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        submitQuestion();
      }
    });
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 110) + 'px';
    });
    const send = el('button', { class: 'send', text: 'Ask', onclick: () => (state.streaming ? cancel() : submitQuestion()) });

    const panel = el('div', { class: 'panel' }, [
      el('div', { class: 'head' }, [
        el('div', { class: 'dot' }),
        el('span', { class: 'title', text: 'Claude Study Buddy' }),
        el('button', { class: 'icon-btn', title: 'Study notes', text: '☰', onclick: () => openExtensionPage('notes') }),
        el('button', { class: 'icon-btn', title: 'Close', text: '✕', onclick: closePanel })
      ]),
      quote,
      chips,
      thread,
      el('div', { class: 'composer' }, [input, send])
    ]);
    makeDraggable(panel, panel.querySelector('.head'));

    shadow.append(bubble, panel);
    (document.body || document.documentElement).appendChild(host);

    state.host = host;
    state.shadow = shadow;
    state.bubble = bubble;
    state.panel = panel;
    state.ui = { quote, quoteText, quoteToggle, chips, thread, input, send };
  }

  function makeDraggable(panel, handle) {
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;
    const onMove = (event) => {
      panel.style.left = Math.max(4, originLeft + event.clientX - startX) + 'px';
      panel.style.top = Math.max(4, originTop + event.clientY - startY) + 'px';
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    handle.addEventListener('mousedown', (event) => {
      if (event.target.closest('button')) return;
      const rect = panel.getBoundingClientRect();
      panel.style.right = 'auto';
      panel.style.left = rect.left + 'px';
      panel.style.top = rect.top + 'px';
      startX = event.clientX;
      startY = event.clientY;
      originLeft = rect.left;
      originTop = rect.top;
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      event.preventDefault();
    });
  }

  function openExtensionPage(page) {
    try {
      chrome.runtime.sendMessage({ type: 'open-page', page });
    } catch {
      /* extension reloaded */
    }
  }

  /* ------------------------------------------------------- panel state */

  function showBubble(rect) {
    if (!settings.bubbleEnabled) return;
    mount();
    const bubble = state.bubble;
    bubble.classList.add('bubble--on');
    const width = bubble.offsetWidth || 220;
    const left = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 8);
    const above = rect.top > 52;
    bubble.style.left = left + 'px';
    bubble.style.top = (above ? rect.top - 44 : rect.bottom + 10) + 'px';
  }

  function hideBubble() {
    if (state.bubble) state.bubble.classList.remove('bubble--on');
  }

  function adoptPending() {
    if (!state.pending) return;
    const { text, range } = state.pending;
    setSubject({ text, context: contextAround(range, text), range });
  }

  function setSubject(subject) {
    mount();
    const previous = state.subject;
    const changed = !previous || previous.text !== subject.text || previous.isPage !== subject.isPage;
    state.subject = subject;
    if (changed) {
      state.thread = [];
      state.ui.thread.replaceChildren();
    }
    state.ui.quoteText.replaceChildren(el('span', {
      text: subject.isPage ? `Whole page — ${document.title || location.hostname}` : subject.text.trim()
    }));
    state.ui.quote.classList.remove('open');
    state.ui.quoteToggle.textContent = 'Show all';
    updateQuoteToggle();
    highlightActive(subject.highlightId);
  }

  /** The quote is clamped to a few lines; only offer "Show all" when it clips. */
  function updateQuoteToggle() {
    const { quote, quoteText, quoteToggle } = state.ui;
    const clipped = quoteText.scrollHeight > quoteText.clientHeight + 2;
    quoteToggle.style.display = clipped || quote.classList.contains('open') ? '' : 'none';
  }

  function highlightActive(id) {
    for (const mark of document.querySelectorAll('mark.' + HL_CLASS)) {
      mark.classList.toggle('claude-study-highlight--active', Boolean(id) && mark.dataset.hlId === id);
    }
  }

  function openPanel(options) {
    mount();
    state.panel.classList.add('panel--on');
    hideBubble();
    updateQuoteToggle();
    if (!state.ui.thread.childElementCount) {
      state.ui.thread.appendChild(
        el('div', {
          class: 'empty',
          text: 'Pick an action above, or type your own question about this passage below.'
        })
      );
    }
    if (options && options.focus) setTimeout(() => state.ui.input.focus(), 0);
  }

  function closePanel() {
    if (state.streaming) cancel();
    if (state.panel) state.panel.classList.remove('panel--on');
    highlightActive(null);
  }

  function togglePanel() {
    mount();
    if (state.panel.classList.contains('panel--on')) closePanel();
    else openPanel();
  }

  /* ---------------------------------------------------------- asking */

  function scrollToEnd() {
    const thread = state.ui.thread;
    thread.scrollTop = thread.scrollHeight;
  }

  function addUserTurn(label) {
    state.ui.thread.appendChild(el('div', { class: 'turn turn--user', text: label }));
    scrollToEnd();
  }

  function startAssistantTurn() {
    const thinking = el('div', { class: 'thinking' });
    thinking.style.display = 'none';
    const body = el('div', { class: 'body cursor' });
    const meta = el('div', { class: 'meta' });
    const turn = el('div', { class: 'turn' }, [thinking, body, meta]);
    state.ui.thread.appendChild(turn);
    state.current = { turn, body, meta, thinking, buffer: '', reasoning: '', pending: false };
    scrollToEnd();
  }

  function renderCurrent() {
    const current = state.current;
    if (!current) return;
    current.pending = false;
    const atBottom =
      state.ui.thread.scrollHeight - state.ui.thread.scrollTop - state.ui.thread.clientHeight < 60;
    current.body.replaceChildren(window.ClaudeMarkdown.render(current.buffer));
    if (atBottom) scrollToEnd();
  }

  function scheduleRender() {
    const current = state.current;
    if (!current || current.pending) return;
    current.pending = true;
    setTimeout(renderCurrent, 60);
  }

  function showError(message, needsKey) {
    mount();
    const box = el('div', { class: 'error', text: message });
    if (needsKey) {
      box.appendChild(el('button', { text: 'Open settings', onclick: () => openExtensionPage('options') }));
    }
    state.ui.thread.appendChild(box);
    scrollToEnd();
  }

  function setBusy(busy) {
    state.streaming = busy;
    state.ui.send.textContent = busy ? 'Stop' : 'Ask';
    state.ui.send.classList.toggle('send--stop', busy);
  }

  function ensurePort() {
    if (state.port) return state.port;
    try {
      const port = chrome.runtime.connect({ name: PORT_NAME });
      port.onMessage.addListener(handlePortMessage);
      port.onDisconnect.addListener(() => {
        state.port = null;
        if (state.streaming) {
          setBusy(false);
          if (state.current) state.current.body.classList.remove('cursor');
          showError('The extension worker restarted mid-answer. Ask again.');
        }
      });
      state.port = port;
      return port;
    } catch {
      return null;
    }
  }

  function cancel() {
    if (state.port) state.port.postMessage({ type: 'cancel' });
    setBusy(false);
    if (state.current) state.current.body.classList.remove('cursor');
  }

  function ask(options) {
    mount();
    const action = options.action || null;
    const isPageAction = action === 'pageSummary' || action === 'pageQuiz';

    if (isPageAction) {
      setSubject({ text: pageText(), context: '', isPage: true });
    } else if (!state.subject || options.freshSelection) {
      adoptPending();
    }

    if (!state.subject) {
      openPanel();
      showError('Select some text on the page first, then ask.');
      return;
    }

    openPanel();
    const empty = state.ui.thread.querySelector('.empty');
    if (empty) empty.remove();

    if (settings.autoHighlight && state.subject.range && !state.subject.highlightId && !state.subject.isPage) {
      try {
        const entry = createHighlight(state.subject.range, state.subject.text);
        if (entry) state.subject.highlightId = entry.id;
      } catch {
        /* unhighlightable DOM - not fatal */
      }
      state.subject.range = null;
      highlightActive(state.subject.highlightId);
    }

    const port = ensurePort();
    if (!port) {
      showError('This page needs a reload before the extension can run here.');
      return;
    }

    const label = action ? ACTION_LABELS[action] || action : options.question;
    addUserTurn(label);
    startAssistantTurn();
    setBusy(true);
    state.requestId += 1;

    port.postMessage({
      type: 'ask',
      requestId: state.requestId,
      history: state.thread,
      payload: {
        action,
        question: options.question || '',
        selection: state.subject.isPage ? '' : state.subject.text,
        pageText: state.subject.isPage ? state.subject.text : '',
        context: state.subject.context || '',
        title: document.title,
        url: docUrl()
      }
    });
  }

  function submitQuestion() {
    const input = state.ui.input;
    const question = input.value.trim();
    if (!question || state.streaming) return;
    input.value = '';
    input.style.height = 'auto';
    ask({ question });
  }

  function handlePortMessage(message) {
    if (!state.shadow) return;
    if (message.requestId && message.requestId !== state.requestId) return;

    switch (message.type) {
      case 'start':
        state.thread.push({ role: 'user', content: message.userMessage });
        break;
      case 'delta':
        if (!state.current) return;
        state.current.buffer += message.text;
        scheduleRender();
        break;
      case 'reasoning':
        if (!state.current) return;
        state.current.reasoning += message.text;
        state.current.thinking.style.display = '';
        state.current.thinking.textContent = state.current.reasoning;
        break;
      case 'notice':
        state.ui.thread.appendChild(el('div', { class: 'notice', text: message.text }));
        scrollToEnd();
        break;
      case 'done':
        finishTurn(message);
        break;
      case 'aborted':
        setBusy(false);
        if (state.current) state.current.body.classList.remove('cursor');
        break;
      case 'error':
        setBusy(false);
        if (state.current) {
          state.current.body.classList.remove('cursor');
          if (!state.current.buffer) state.current.turn.remove();
        }
        showError(message.message, message.needsKey);
        break;
      default:
        break;
    }
  }

  function finishTurn(message) {
    setBusy(false);
    const current = state.current;
    if (!current) return;
    current.buffer = message.text || current.buffer;
    renderCurrent();
    current.body.classList.remove('cursor');
    state.thread.push({ role: 'assistant', content: current.buffer });

    const usage = message.usage || {};
    const bits = [message.model];
    if (usage.input_tokens || usage.output_tokens) {
      bits.push(`${usage.input_tokens || 0} in / ${usage.output_tokens || 0} out`);
    }
    if (typeof message.cost === 'number') {
      bits.push('$' + (message.cost < 0.001 ? message.cost.toPrecision(2) : message.cost.toFixed(4)));
    }

    const saved = el('span', { text: '' });
    current.meta.replaceChildren(
      el('span', { text: bits.filter(Boolean).join(' · ') }),
      el('button', {
        text: 'Copy',
        onclick: async () => {
          await navigator.clipboard.writeText(current.buffer);
          saved.textContent = 'copied';
          setTimeout(() => { saved.textContent = ''; }, 1400);
        }
      }),
      el('button', {
        text: 'Save note',
        onclick: async () => {
          await saveNote(current.buffer);
          saved.textContent = 'saved';
          setTimeout(() => { saved.textContent = ''; }, 1400);
        }
      }),
      saved
    );
    scrollToEnd();
  }

  async function saveNote(answer) {
    const lastUser = [...state.thread].reverse().find((turn) => turn.role === 'user');
    const store = await chrome.storage.local.get('notes');
    const notes = store.notes || [];
    notes.push({
      id: 'note_' + Date.now().toString(36),
      url: docUrl(),
      title: document.title,
      selection: state.subject && !state.subject.isPage ? state.subject.text : '',
      question: lastUser ? lastUser.content.slice(0, 400) : '',
      answer,
      createdAt: Date.now()
    });
    await chrome.storage.local.set({ notes: notes.slice(-500) });
  }

  /* --------------------------------------------------------- listeners */

  let selectionTimer = null;
  function onSelectionEvent() {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      const found = readSelection();
      if (found) {
        state.pending = found;
        showBubble(found.rect);
      } else {
        state.pending = null;
        hideBubble();
      }
    }, 10);
  }

  document.addEventListener('mouseup', onSelectionEvent, true);
  document.addEventListener('keyup', (event) => {
    if (event.shiftKey || event.key === 'Escape') onSelectionEvent();
  }, true);
  document.addEventListener('mousedown', (event) => {
    if (state.host && event.composedPath().includes(state.host)) return;
    hideBubble();
  }, true);
  window.addEventListener('scroll', hideBubble, { passive: true, capture: true });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.panel && state.panel.classList.contains('panel--on')) {
      closePanel();
    }
  });

  document.addEventListener('click', (event) => {
    const mark = event.target.closest && event.target.closest('mark.' + HL_CLASS);
    if (!mark) return;
    const id = mark.dataset.hlId;
    if (event.altKey) {
      event.preventDefault();
      forgetHighlight(id);
      return;
    }
    const marks = [...document.querySelectorAll(`mark.${HL_CLASS}[data-hl-id="${id}"]`)];
    const text = marks.map((node) => node.textContent).join('');
    const range = document.createRange();
    range.setStartBefore(marks[0]);
    range.setEndAfter(marks[marks.length - 1]);
    setSubject({ text, context: contextAround(range, text), highlightId: id });
    openPanel();
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'run-action') {
      mount();
      const live = readSelection();
      if (live) {
        state.pending = live;
        setSubject({ text: live.text, context: contextAround(live.range, live.text), range: live.range });
      } else if (message.selectionText && normalize(message.selectionText).length > 1) {
        setSubject({ text: message.selectionText, context: '' });
      }
      if (message.action === 'highlight') {
        if (live) {
          const entry = createHighlight(live.range, live.text);
          if (entry) {
            state.subject.highlightId = entry.id;
            highlightActive(entry.id);
          }
        }
        sendResponse({ ok: true });
        return false;
      }
      ask({ action: message.action });
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === 'toggle-panel') {
      togglePanel();
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  /* -------------------------------------------------------------- init */

  loadSettings();
  let restoreTimer = null;
  const restoreSoon = () => {
    clearTimeout(restoreTimer);
    restoreTimer = setTimeout(() => restoreAll().catch(() => {}), 120);
  };
  // The PDF viewer renders pages lazily and calls this as each one appears.
  window.__claudeStudyRestoreHighlights = restoreSoon;
  if (document.readyState === 'complete') restoreSoon();
  else window.addEventListener('load', restoreSoon, { once: true });
  setTimeout(restoreSoon, 2500);
})();
