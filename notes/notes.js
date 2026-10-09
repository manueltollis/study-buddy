const $ = (id) => document.getElementById(id);
const state = { tab: 'notes', query: '', notes: [], highlights: {}, autoSave: true, vault: {}, vaultConnected: false };

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
  const store = await chrome.storage.local.get(['notes', 'highlights', 'settings', 'vault']);
  state.notes = (store.notes || []).slice().reverse();
  state.highlights = store.highlights || {};
  state.autoSave = store.settings?.autoSaveNotes !== false;
  state.vault = store.vault || {};
  state.vaultConnected = Boolean(store.settings?.vaultKey);
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
      : state.autoSave
        ? 'No saved notes yet. Every answer you get in the panel lands here.'
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
        note.selection ? el('blockquote', { class: 'quote' }, [el('span', { class: 'swipe', text: note.selection })]) : null,
        answer,
        el('div', { class: 'card__foot' }, [
          el('button', {
            class: 'ghost',
            text: 'Copy',
            onclick: () => navigator.clipboard.writeText(note.answer)
          }),
          ...vaultControls(note),
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
        ]),
        studyNext(note)
      ])
    );
  }
}

/** What the librarian thinks is worth looking into after this note. */
function studyNext(note) {
  const entry = state.vault[note.id];
  if (entry?.status !== 'filed' || !entry.suggestions?.length) return null;
  return el('div', { class: 'next' }, [
    el('div', { class: 'ask', text: 'Study next' }),
    el(
      'ul',
      {},
      entry.suggestions.map((topic) =>
        el('li', {}, [el('b', { text: topic.name }), topic.why ? el('span', { text: ` — ${topic.why}` }) : null])
      )
    )
  ]);
}

/** Where the librarian has got to with a note, and what can be done about it. */
function vaultControls(note) {
  const entry = state.vault[note.id];
  if (!state.vaultConnected && !entry) return [];
  const file = (label) =>
    el('button', {
      class: 'ghost',
      text: label,
      onclick: () => chrome.runtime.sendMessage({ type: 'vault-file', noteId: note.id })
    });
  const undo = () =>
    el('button', {
      class: 'ghost',
      text: 'Undo',
      title: 'Reverse the librarian’s changes for this note',
      onclick: async (event) => {
        event.target.disabled = true;
        const result = await chrome.runtime.sendMessage({ type: 'vault-undo', noteId: note.id });
        if (!result?.ok) alert(result?.message || 'Undo failed.');
      }
    });
  const status = (text, kind, title) => el('span', { class: `vault vault--${kind}`, text, title });
  const paths = [...new Set((entry?.ops || []).map((op) => op.path))];

  if (!entry) return [file('File in vault')];
  switch (entry.status) {
    case 'queued':
      return [status('Waiting to file…', 'busy')];
    case 'working':
      return [status(`Filing — ${entry.step || 'working'}…`, 'busy')];
    case 'filed':
      return [status(`In vault: ${paths.join(', ') || 'no changes'}`, 'ok', entry.summary), paths.length ? undo() : null];
    case 'undone':
      return [status('Taken back out of the vault', 'muted'), file('File again')];
    default:
      return [status(`Filing failed: ${entry.error || 'unknown error'}`, 'err'), paths.length ? undo() : null, file('Retry')];
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
          el('span', {}, [el('span', { class: 'swipe', text: item.text })]),
          el('button', {
            class: 'ghost danger',
            text: 'Remove',
            onclick: async () => {
              const store = await chrome.storage.local.get('highlights');
              const all = store.highlights || {};
              all[url] = (all[url] || []).filter((h) => h.id !== item.id);
              if (!all[url].length) delete all[url];
              await chrome.storage.local.set({ highlights: all });
              await chrome.storage.local.remove('chat:' + item.id);
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
  const link = el('a', { href: URL.createObjectURL(blob), download: 'study-buddy-notes.md' });
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
