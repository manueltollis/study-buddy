/**
 * Tiny, dependency-free Markdown renderer.
 *
 * Builds real DOM nodes with textContent only - no innerHTML anywhere - so
 * model output can never inject markup into the page it is rendered on.
 * Exposed as a global because the same file is loaded both as a content
 * script and with a <script> tag on the extension's own pages.
 */
(function () {
  const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]\n]+\]\([^)\s]+\))/g;

  function safeHref(url) {
    const trimmed = String(url).trim();
    return /^(https?:|mailto:)/i.test(trimmed) ? trimmed : null;
  }

  function renderInline(text, parent) {
    let last = 0;
    let match;
    INLINE.lastIndex = 0;
    while ((match = INLINE.exec(text)) !== null) {
      if (match.index > last) {
        parent.appendChild(document.createTextNode(text.slice(last, match.index)));
      }
      const token = match[0];
      if (token.startsWith('`')) {
        const code = document.createElement('code');
        code.textContent = token.slice(1, -1);
        parent.appendChild(code);
      } else if (token.startsWith('**') || token.startsWith('__')) {
        const strong = document.createElement('strong');
        strong.textContent = token.slice(2, -2);
        parent.appendChild(strong);
      } else if (token.startsWith('[')) {
        const split = token.indexOf('](');
        const label = token.slice(1, split);
        const href = safeHref(token.slice(split + 2, -1));
        if (href) {
          const a = document.createElement('a');
          a.href = href;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = label;
          parent.appendChild(a);
        } else {
          parent.appendChild(document.createTextNode(label));
        }
      } else {
        const em = document.createElement('em');
        em.textContent = token.slice(1, -1);
        parent.appendChild(em);
      }
      last = match.index + token.length;
    }
    if (last < text.length) {
      parent.appendChild(document.createTextNode(text.slice(last)));
    }
    return parent;
  }

  function render(markdown) {
    const frag = document.createDocumentFragment();
    const lines = String(markdown || '').split('\n');
    let i = 0;
    let list = null;

    const closeList = () => { list = null; };

    while (i < lines.length) {
      const line = lines[i];

      // Fenced code block
      const fence = line.match(/^\s*```(\w+)?\s*$/);
      if (fence) {
        closeList();
        const body = [];
        i += 1;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
          body.push(lines[i]);
          i += 1;
        }
        i += 1;
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        if (fence[1]) code.dataset.lang = fence[1];
        code.textContent = body.join('\n');
        pre.appendChild(code);
        frag.appendChild(pre);
        continue;
      }

      if (!line.trim()) { closeList(); i += 1; continue; }

      if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
        closeList();
        frag.appendChild(document.createElement('hr'));
        i += 1;
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        closeList();
        const h = document.createElement('h' + Math.min(heading[1].length + 2, 6));
        renderInline(heading[2], h);
        frag.appendChild(h);
        i += 1;
        continue;
      }

      const quote = line.match(/^\s*>\s?(.*)$/);
      if (quote) {
        closeList();
        const bq = document.createElement('blockquote');
        const parts = [quote[1]];
        i += 1;
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          parts.push(lines[i].replace(/^\s*>\s?/, ''));
          i += 1;
        }
        renderInline(parts.join(' '), bq);
        frag.appendChild(bq);
        continue;
      }

      const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
      const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (bullet || numbered) {
        const tag = bullet ? 'ul' : 'ol';
        if (!list || list.tagName.toLowerCase() !== tag) {
          list = document.createElement(tag);
          frag.appendChild(list);
        }
        const li = document.createElement('li');
        renderInline((bullet || numbered)[1], li);
        list.appendChild(li);
        i += 1;
        continue;
      }

      closeList();
      const p = document.createElement('p');
      const paragraph = [line];
      i += 1;
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^\s*(#{1,6}\s|>|[-*+]\s|\d+[.)]\s|```)/.test(lines[i])
      ) {
        paragraph.push(lines[i]);
        i += 1;
      }
      renderInline(paragraph.join('\n'), p);
      frag.appendChild(p);
    }

    return frag;
  }

  globalThis.ClaudeMarkdown = { render };
})();
