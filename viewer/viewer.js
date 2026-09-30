/**
 * Study viewer.
 *
 * Chrome renders PDFs in a plugin with no text DOM, so nothing can be selected
 * or highlighted there. This page renders the same PDF with pdf.js: a canvas
 * for the visuals plus pdf.js's text layer - real, positioned <span>s - on top.
 * That layer is ordinary DOM, so content/content.js (loaded before this file)
 * gives the page its selection bubble, panel and persistent highlights with no
 * changes at all.
 */
import * as pdfjs from '../lib/pdfjs/pdf.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdfjs/pdf.worker.mjs');

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const fileUrl = params.get('file') || '';
const ZOOMS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5];

const state = { doc: null, scale: 1.25, pages: [], rendering: new Set(), fullText: '' };

function notice(title, body, actions) {
  $('pages').replaceChildren();
  const box = document.createElement('div');
  box.className = 'notice';
  const h = document.createElement('h2');
  h.textContent = title;
  const p = document.createElement('p');
  p.textContent = body;
  box.append(h, p);
  for (const action of actions || []) {
    const button = document.createElement('button');
    button.textContent = action.label;
    if (action.primary) button.className = 'primary';
    button.addEventListener('click', action.onClick);
    box.appendChild(button);
    box.appendChild(document.createTextNode(' '));
  }
  const holder = $('notice');
  holder.hidden = false;
  holder.replaceChildren(box);
}

/* --------------------------------------------------------------- render */

function pageContainer(index, viewport) {
  const div = document.createElement('div');
  div.className = 'page';
  div.dataset.page = String(index + 1);
  div.style.width = `${Math.floor(viewport.width)}px`;
  div.style.height = `${Math.floor(viewport.height)}px`;
  const pending = document.createElement('div');
  pending.className = 'pending';
  pending.textContent = `Page ${index + 1}`;
  div.appendChild(pending);
  return div;
}

async function renderPage(index) {
  const holder = state.pages[index];
  if (!holder || state.rendering.has(index) || holder.dataset.done === 'yes') return;
  state.rendering.add(index);
  try {
    const page = await state.doc.getPage(index + 1);
    const viewport = page.getViewport({ scale: state.scale });
    const ratio = Math.min(window.devicePixelRatio || 1, 2);

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;

    await page.render({
      canvasContext: canvas.getContext('2d', { alpha: false }),
      canvas,
      viewport,
      transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0]
    }).promise;

    const textDiv = document.createElement('div');
    textDiv.className = 'textLayer';
    textDiv.style.setProperty('--total-scale-factor', String(state.scale));
    const textLayer = new pdfjs.TextLayer({
      textContentSource: page.streamTextContent(),
      container: textDiv,
      viewport
    });
    await textLayer.render();

    // Links are a bonus; a malformed annotation must not cost the reader the page.
    const linkDiv = await renderLinks(page, viewport).catch((error) => {
      console.warn('Study viewer: could not lay out links', error);
      return document.createElement('div');
    });

    holder.replaceChildren(canvas, textDiv, linkDiv);
    holder.dataset.done = 'yes';
    // Highlights saved for this document may live on a page that just appeared.
    window.__claudeStudyRestoreHighlights?.();
  } catch (error) {
    console.warn('Study viewer: page render failed', error);
  } finally {
    state.rendering.delete(index);
  }
}

/**
 * The canvas and text layer carry no links, so a PDF's link annotations get
 * their own layer of positioned <a>s on top: web links open in a new tab,
 * internal ones (table of contents, citations, "see page 4") scroll the viewer.
 */
async function renderLinks(page, viewport) {
  const layer = document.createElement('div');
  layer.className = 'linkLayer';
  let annotations = [];
  try {
    annotations = await page.getAnnotations({ intent: 'display' });
  } catch (error) {
    console.warn('Study viewer: could not read links', error);
  }
  for (const annotation of annotations) {
    if (annotation.subtype !== 'Link' || !annotation.rect) continue;
    const href = annotation.url || annotation.unsafeUrl;
    const internal = annotation.dest;
    if (!href && !internal) continue;

    const [ax, ay] = viewport.convertToViewportPoint(annotation.rect[0], annotation.rect[1]);
    const [bx, by] = viewport.convertToViewportPoint(annotation.rect[2], annotation.rect[3]);
    const [x1, x2] = [Math.min(ax, bx), Math.max(ax, bx)];
    const [y1, y2] = [Math.min(ay, by), Math.max(ay, by)];
    const a = document.createElement('a');
    a.style.left = `${x1}px`;
    a.style.top = `${y1}px`;
    a.style.width = `${x2 - x1}px`;
    a.style.height = `${y2 - y1}px`;
    if (href) {
      let url = null;
      try {
        url = new URL(href, fileUrl);
      } catch {
        continue;
      }
      if (!/^(https?|mailto):$/.test(url.protocol)) continue;
      a.href = url.href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.title = url.href;
    } else {
      a.href = '#';
      a.addEventListener('click', (event) => {
        event.preventDefault();
        followDestination(internal);
      });
    }
    layer.appendChild(a);
  }
  return layer;
}

async function followDestination(dest) {
  try {
    const explicit = typeof dest === 'string' ? await state.doc.getDestination(dest) : dest;
    if (!Array.isArray(explicit)) return;
    const target = explicit[0];
    const index = typeof target === 'number' ? target : await state.doc.getPageIndex(target);
    const holder = state.pages[index];
    if (!holder) return;
    // XYZ destinations name a spot on the page; land there rather than the page top.
    let offset = 0;
    if (explicit[1]?.name === 'XYZ' && typeof explicit[3] === 'number') {
      const page = await state.doc.getPage(index + 1);
      const [, y] = page.getViewport({ scale: state.scale }).convertToViewportPoint(0, explicit[3]);
      offset = Math.max(0, y);
    }
    const bar = document.querySelector('.bar')?.offsetHeight || 0;
    const top = holder.getBoundingClientRect().top + window.scrollY + offset - bar - 8;
    window.scrollTo({ top, behavior: 'smooth' });
  } catch (error) {
    console.warn('Study viewer: could not follow link', error);
  }
}

const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const index = Number(entry.target.dataset.page) - 1;
      renderPage(index);
      renderPage(index + 1); // keep one page ahead of the reader
    }
  },
  { rootMargin: '600px 0px' }
);

async function layout() {
  const container = $('pages');
  container.replaceChildren();
  state.pages = [];
  observer.disconnect();

  const first = await state.doc.getPage(1);
  const base = first.getViewport({ scale: state.scale });
  for (let i = 0; i < state.doc.numPages; i += 1) {
    const holder = pageContainer(i, base);
    container.appendChild(holder);
    state.pages.push(holder);
    observer.observe(holder);
  }
  // Pages can differ in size; correct each one as it renders.
  for (let i = 0; i < Math.min(2, state.pages.length); i += 1) renderPage(i);
}

/* ------------------------------------------------------- whole-document */

async function extractText() {
  const chunks = [];
  for (let i = 1; i <= state.doc.numPages; i += 1) {
    const page = await state.doc.getPage(i);
    const content = await page.getTextContent();
    let line = '';
    const lines = [];
    for (const item of content.items) {
      line += item.str;
      if (item.hasEOL) {
        lines.push(line);
        line = '';
      }
    }
    if (line) lines.push(line);
    chunks.push(lines.join('\n'));
  }
  state.fullText = chunks.join('\n\n');
}

/* ---------------------------------------------------------------- chrome */

function currentPage() {
  const middle = window.innerHeight / 2;
  let best = 1;
  for (const holder of state.pages) {
    const rect = holder.getBoundingClientRect();
    if (rect.top <= middle) best = Number(holder.dataset.page);
  }
  return best;
}

function goToPage(number) {
  const holder = state.pages[Math.min(Math.max(number, 1), state.pages.length) - 1];
  if (holder) holder.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function setZoom(direction) {
  const at = ZOOMS.indexOf(state.scale);
  const next = ZOOMS[Math.min(Math.max((at === -1 ? 2 : at) + direction, 0), ZOOMS.length - 1)];
  if (next === state.scale) return;
  const page = currentPage();
  state.scale = next;
  localStorage.setItem('claude-study-zoom', String(next));
  $('zoomLabel').textContent = `${Math.round(next * 100)}%`;
  await layout();
  goToPage(page);
}

function wireChrome() {
  $('prev').addEventListener('click', () => goToPage(currentPage() - 1));
  $('next').addEventListener('click', () => goToPage(currentPage() + 1));
  $('zoomIn').addEventListener('click', () => setZoom(1));
  $('zoomOut').addEventListener('click', () => setZoom(-1));
  $('pageNum').addEventListener('change', () => goToPage(Number($('pageNum').value) || 1));
  $('original').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'open-original', url: fileUrl });
  });
  window.addEventListener(
    'scroll',
    () => {
      if (document.activeElement !== $('pageNum')) $('pageNum').value = String(currentPage());
    },
    { passive: true }
  );
}

function handleLoadError(error) {
  const message = String(error?.message || error);
  const isFile = fileUrl.startsWith('file:');
  if (isFile) {
    notice(
      'Chrome is blocking this local file',
      'Local PDFs need file access for this extension. Open chrome://extensions, find Claude Study Buddy, and turn on "Allow access to file URLs", then reload this tab.',
      [{ label: 'Reload', onClick: () => location.reload(), primary: true }]
    );
    return;
  }
  let origin = '';
  try {
    origin = new URL(fileUrl).origin;
  } catch {
    /* not a URL */
  }
  notice(
    'Could not load this PDF',
    `${message}${origin ? ` — the extension may not have access to ${origin}.` : ''}`,
    [
      origin && {
        label: `Grant access to ${origin}`,
        primary: true,
        onClick: async () => {
          const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
          if (granted) location.reload();
        }
      },
      {
        label: 'Open the original',
        onClick: () => chrome.runtime.sendMessage({ type: 'open-original', url: fileUrl })
      }
    ].filter(Boolean)
  );
}

async function main() {
  if (!fileUrl) {
    notice('No PDF to show', 'This page opens a PDF passed as ?file=<url>.', []);
    return;
  }
  const saved = Number(localStorage.getItem('claude-study-zoom'));
  if (ZOOMS.includes(saved)) state.scale = saved;
  $('zoomLabel').textContent = `${Math.round(state.scale * 100)}%`;

  const name = decodeURIComponent(fileUrl.split('/').pop() || 'document.pdf');
  $('title').textContent = name;
  document.title = `${name} — Study viewer`;
  wireChrome();

  try {
    state.doc = await pdfjs.getDocument({ url: fileUrl }).promise;
  } catch (error) {
    handleLoadError(error);
    return;
  }

  $('pageCount').textContent = `/ ${state.doc.numPages}`;
  await layout();

  // Page-level actions ask about the whole document, not just rendered pages.
  window.__claudeStudyPageText = () => state.fullText;
  extractText().then(() => {
    const meta = state.doc.getMetadata ? state.doc.getMetadata() : null;
    if (meta) {
      meta.then((info) => {
        const title = info?.info?.Title;
        if (title && title.trim()) {
          $('title').textContent = title.trim();
          document.title = `${title.trim()} — Study viewer`;
        }
      }).catch(() => {});
    }
  });
}

main();
