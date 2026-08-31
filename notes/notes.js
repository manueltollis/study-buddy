const $ = (id) => document.getElementById(id);
const state = { tab: 'notes', query: '', notes: [], highlights: {} };

const fmtDate = (ts) =>
  new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function el(tag, props, children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
      else node.setAttribute(key, value);
    }
  }
  for (const child of [].concat(children || [])) if (child) node.appendChild(child);
  return node;
}

async function load() {
  const store = await chrome.storage.local.get(['notes', 'highlights']);
  state.notes = (store.notes || []).slice().reverse();
  state.highlights = store.highlights || {};
  render();
}

function matches(text) {
  return !state.query || String(text || '').toLowerCase().includes(state.query);
}

function renderNotes(list) {
  const notes = state.notes.filter(
    (note) => matches(note.answer) || matches(note.selection) || matches(note.title) || matches(note.question)
  );
  if (!notes.length) {
    $('empty').hidden = false;
    $('empty').textContent = state.query
      ? 'No notes match that search.'
      : 'No saved notes yet. Hit “Save note” under any answer.';
    return;
  }
  for (const note of notes) {
    const answer = el('div', { class: 'answer' });
    answer.appendChild(window.ClaudeMarkdown.render(note.answer));
    list.appendChild(
      el('article', { class: 'card' }, [
        el('div', { class: 'card__head' }, [
          el('div', { class: 'card__site' }, [
            el('a', { href: note.url, target: '_blank', rel: 'noreferrer', text: note.title || note.url })
          ]),
          el('div', { class: 'card__date', text: fmtDate(note.createdAt) })
        ]),
        note.selection ? el('blockquote', { class: 'quote', text: note.selection }) : null,
        answer,
        el('div', { class: 'card__foot' }, [
          el('button', {
            class: 'ghost',
            text: 'Copy',
            onclick: () => navigator.clipboard.writeText(note.answer)
          }),
          el('button', {
            class: 'ghost danger',
            text: 'Delete',
            onclick: async () => {
              const store = await chrome.storage.local.get('notes');
              await chrome.storage.local.set({
                notes: (store.notes || []).filter((n) => n.id !== note.id)
              });
              load();
            }
          })
        ])
      ])
    );
  }
}

function renderHighlights(list) {
  const pages = Object.entries(state.highlights)
    .map(([url, items]) => [url, (items || []).filter((item) => matches(item.text) || matches(item.title))])
    .filter(([, items]) => items.length);

  if (!pages.length) {
    $('empty').hidden = false;
    $('empty').textContent = state.query ? 'No highlights match that search.' : 'No highlights yet.';
    return;
  }

  for (const [url, items] of pages) {
    const rows = items
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((item) =>
        el('div', { class: 'hl' }, [
          el('span', { text: item.text }),
          el('button', {
            class: 'ghost danger',
            text: 'Remove',
            onclick: async () => {
              const store = await chrome.storage.local.get('highlights');
              const all = store.highlights || {};
              all[url] = (all[url] || []).filter((h) => h.id !== item.id);
              if (!all[url].length) delete all[url];
              await chrome.storage.local.set({ highlights: all });
              load();
            }
          })
        ])
      );
    list.appendChild(
      el('section', { class: 'group' }, [
        el('div', { class: 'group__head' }, [
          el('div', { class: 'group__title' }, [
            el('a', { href: url, target: '_blank', rel: 'noreferrer', text: items[0].title || url })
          ]),
          el('div', { class: 'group__count', text: `${items.length} highlight${items.length === 1 ? '' : 's'}` })
        ]),
        ...rows
      ])
    );
  }
}

function render() {
  const list = $('list');
  list.replaceChildren();
  $('empty').hidden = true;
  if (state.tab === 'notes') renderNotes(list);
  else renderHighlights(list);
}

function exportMarkdown() {
  const lines = ['# Study notes', ''];
  for (const note of [...state.notes].reverse()) {
    lines.push(`## ${note.title || note.url}`, '', `<${note.url}> — ${fmtDate(note.createdAt)}`, '');
    if (note.selection) lines.push('> ' + note.selection.replace(/\n/g, '\n> '), '');
    lines.push(note.answer, '', '---', '');
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
  const link = el('a', { href: URL.createObjectURL(blob), download: 'claude-study-notes.md' });
  document.body.appendChild(link);
  link.click();
  link.remove();
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.tab')) other.classList.toggle('is-on', other === tab);
    state.tab = tab.dataset.tab;
    render();
  });
}
$('search').addEventListener('input', (event) => {
  state.query = event.target.value.trim().toLowerCase();
  render();
});
$('export').addEventListener('click', exportMarkdown);
chrome.storage.onChanged.addListener(load);
load();
