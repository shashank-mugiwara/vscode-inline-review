(function () {
  const api = acquireVsCodeApi();
  const content = document.getElementById('content');
  const listEl = document.getElementById('list');
  const railEl = document.getElementById('rail');
  const btnList = document.getElementById('btn-list');
  let comments = [];
  let cards = [];      // {id, line, el} in document order
  let cursor = -1;

  // ---------------------------------------------------------------- plumbing

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'update') {
      content.innerHTML = m.html;
      comments = m.comments || [];
      installAddButtons();
      paint();
      renderMermaid();
    } else if (m.type === 'comments') {
      comments = m.comments || [];
      paint();
    } else if (m.type === 'reveal') {
      const i = cards.findIndex((c) => c.id === m.id);
      if (i >= 0) goTo(i);
      else revealLine(m.line);
    }
  });

  document.getElementById('btn-copy').addEventListener('click', () => {
    api.postMessage({ type: 'copyAll' });
  });
  document.getElementById('btn-source').addEventListener('click', () => {
    api.postMessage({ type: 'openSource', line: currentLine() });
  });
  document.getElementById('btn-prev').addEventListener('click', () => step(-1));
  document.getElementById('btn-next').addEventListener('click', () => step(1));
  btnList.addEventListener('click', () => {
    listEl.hidden = !listEl.hidden;
  });

  document.addEventListener('keydown', (e) => {
    const typing = /^(TEXTAREA|INPUT)$/.test(document.activeElement?.tagName || '');
    if (typing) return;
    if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); step(1); }
    else if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
    else if (e.key === 'Escape') listEl.hidden = true;
  });

  // ---------------------------------------------------------------- navigation

  function step(dir) {
    if (!cards.length) return;
    // Start from whatever is on screen rather than from the last jump.
    if (cursor < 0) {
      const mid = window.innerHeight / 2;
      cursor = cards.findIndex((c) => c.el.getBoundingClientRect().top > mid);
      if (cursor < 0) cursor = dir > 0 ? -1 : cards.length;
    }
    let next = cursor + dir;
    if (next < 0) next = cards.length - 1;
    if (next >= cards.length) next = 0;
    goTo(next);
  }

  function goTo(i) {
    const c = cards[i];
    if (!c) return;
    cursor = i;
    listEl.hidden = true;
    c.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    flash(c.el);
    markActive();
  }

  function revealLine(line) {
    const a = anchorFor(anchors(), line);
    if (a) {
      a.scrollIntoView({ behavior: 'smooth', block: 'center' });
      flash(a);
    }
  }

  function flash(el) {
    el.classList.remove('ir-flash');
    void el.offsetWidth; // restart the animation
    el.classList.add('ir-flash');
    setTimeout(() => el.classList.remove('ir-flash'), 1200);
  }

  function markActive() {
    [...listEl.children].forEach((li, i) => li.classList.toggle('active', i === cursor));
    [...railEl.children].forEach((d, i) => d.classList.toggle('active', i === cursor));
  }

  function buildIndex() {
    cards = [...content.querySelectorAll('.ir-card')].map((el) => ({
      id: Number(el.dataset.id),
      line: Number(el.dataset.commentLine),
      el,
    }));
    if (cursor >= cards.length) cursor = -1;

    btnList.textContent = `${cards.length} comment${cards.length === 1 ? '' : 's'}`;
    btnList.disabled = cards.length === 0;
    if (!cards.length) listEl.hidden = true;

    // dropdown
    listEl.textContent = '';
    cards.forEach((c, i) => {
      const li = document.createElement('div');
      li.className = 'ir-list-item';
      const ln = document.createElement('span');
      ln.className = 'ir-list-line';
      ln.textContent = `L${c.line + 1}`;
      const tx = document.createElement('span');
      tx.className = 'ir-list-text';
      tx.textContent = (c.el.querySelector('.ir-body')?.textContent || '').split('\n')[0];
      li.append(ln, tx);
      li.addEventListener('click', () => goTo(i));
      listEl.appendChild(li);
    });

    buildRail();
    markActive();
  }

  function buildRail() {
    railEl.textContent = '';
    const h = document.documentElement.scrollHeight || 1;
    cards.forEach((c, i) => {
      const dot = document.createElement('button');
      dot.className = 'ir-dot';
      dot.title = `L${c.line + 1}`;
      const top = c.el.getBoundingClientRect().top + window.scrollY;
      dot.style.top = `${Math.min(99.5, (top / h) * 100)}%`;
      dot.addEventListener('click', () => goTo(i));
      railEl.appendChild(dot);
    });
  }

  window.addEventListener('resize', buildRail);

  function currentLine() {
    const blocks = [...content.querySelectorAll('.ir-block[data-line]')];
    for (const b of blocks) {
      if (b.getBoundingClientRect().bottom > 80) return Number(b.dataset.line);
    }
    return 0;
  }

  // ---------------------------------------------------------------- mermaid

  let mermaidTheme = null;

  function themeKey() {
    const cls = document.body.classList;
    return cls.contains('vscode-high-contrast-light') ? 'hc-light'
      : cls.contains('vscode-high-contrast') ? 'hc'
        : cls.contains('vscode-dark') ? 'dark' : 'light';
  }

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.body).getPropertyValue(name).trim();
    return v || fallback;
  }

  /** Re-initialise only when the colour theme actually changed. */
  function initMermaid() {
    if (!window.mermaid) return;
    const key = themeKey();
    if (mermaidTheme === key) return;

    const dark = key === 'dark' || key === 'hc';
    const bg = cssVar('--vscode-editor-background', dark ? '#1e1e1e' : '#ffffff');

    window.mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: dark ? 'dark' : 'default',
      darkMode: dark,
      fontFamily: cssVar('--vscode-font-family', 'sans-serif'),
      // Only the canvas is overridden. Node and edge colours stay with mermaid's
      // own theme, which is tuned for the background it sits on.
      themeVariables: { background: bg, edgeLabelBackground: bg },
    });
    mermaidTheme = key;
  }

  /** Redraw every diagram from its saved source — used when the theme flips. */
  function rerenderMermaid() {
    content.querySelectorAll('.ir-mermaid-msg').forEach((n) => n.remove());
    const nodes = [...content.querySelectorAll('pre.ir-mermaid')];
    for (const n of nodes) {
      if (!n.dataset.src) continue;
      n.classList.remove('ir-mermaid-done', 'ir-mermaid-error');
      n.textContent = n.dataset.src;
    }
    renderMermaid();
  }

  // VS Code swaps body classes when the colour theme changes.
  let themeTimer;
  new MutationObserver(() => {
    clearTimeout(themeTimer);
    themeTimer = setTimeout(() => {
      if (themeKey() !== mermaidTheme) rerenderMermaid();
    }, 60);
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  let railDirty = false;

  async function renderMermaid() {
    const nodes = [...content.querySelectorAll('pre.ir-mermaid')];
    if (!nodes.length) return;
    if (!window.mermaid) {
      for (const n of nodes) fail(n, 'mermaid bundle did not load');
      return;
    }
    initMermaid();
    for (const n of nodes) {
      if (!n.dataset.src) n.dataset.src = n.textContent;
      const src = n.dataset.src;
      try {
        const id = 'ir-mmd-' + Math.random().toString(36).slice(2);
        const { svg } = await window.mermaid.render(id, src);
        n.innerHTML = svg;
        n.classList.add('ir-mermaid-done');
        railDirty = true;
      } catch (err) {
        fail(n, (err && err.message ? String(err.message) : 'render failed').split('\n')[0], src);
        railDirty = true;
      }
    }
    if (railDirty) {
      railDirty = false;
      buildRail();
    }
  }

  function fail(node, message, src) {
    node.classList.add('ir-mermaid-error');
    if (src !== undefined) node.textContent = src;
    const msg = document.createElement('div');
    msg.className = 'ir-mermaid-msg';
    msg.textContent = 'Mermaid: ' + message;
    node.after(msg);
  }

  // ---------------------------------------------------------------- painting

  function anchors() {
    return [...content.querySelectorAll('.ir-block[data-line]')]
      .map((el) => ({ el, line: Number(el.dataset.line) }))
      .sort((a, b) => a.line - b.line);
  }

  /** A comment made in the source gutter may sit mid-block; snap it to the block it falls in. */
  function anchorFor(list, line) {
    let best = null;
    for (const a of list) {
      if (a.line <= line) best = a;
      else break;
    }
    return best ? best.el : null;
  }

  /** A list item must hold its comments inside; everything else takes them as a sibling. */
  function place(block, node) {
    if (block.tagName === 'LI') block.appendChild(node);
    else block.after(node);
  }

  function paint() {
    content.querySelectorAll('.ir-comments').forEach((n) => n.remove());
    const list = anchors();
    const groups = new Map();
    for (const c of comments) {
      const el = anchorFor(list, c.line) || content.firstElementChild;
      if (!el) continue;
      if (!groups.has(el)) groups.set(el, []);
      groups.get(el).push(c);
    }
    for (const [el, group] of groups) {
      const box = document.createElement('div');
      box.className = 'ir-comments';
      for (const c of group) box.appendChild(card(c));
      place(el, box);
    }
    buildIndex();
  }

  function card(c) {
    const el = document.createElement('div');
    el.className = 'ir-card';
    el.dataset.id = String(c.id);
    el.dataset.commentLine = String(c.line);

    const meta = document.createElement('div');
    meta.className = 'ir-meta';
    meta.textContent = `Line ${c.line + 1}`;

    const actions = document.createElement('span');
    actions.className = 'ir-actions';
    const edit = document.createElement('button');
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => startEdit(el, c));
    const del = document.createElement('button');
    del.textContent = 'Delete';
    del.addEventListener('click', () => api.postMessage({ type: 'delete', id: c.id }));
    actions.append(edit, del);
    meta.appendChild(actions);

    const body = document.createElement('div');
    body.className = 'ir-body';
    body.textContent = c.body;

    el.append(meta, body);
    return el;
  }

  function startEdit(cardEl, c) {
    const body = cardEl.querySelector('.ir-body');
    const ta = document.createElement('textarea');
    ta.value = c.body;
    const bar = document.createElement('div');
    bar.className = 'ir-bar';
    const save = document.createElement('button');
    save.className = 'primary';
    save.textContent = 'Save';
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    bar.append(save, cancel);
    body.replaceWith(ta);
    ta.after(bar);
    ta.focus();

    const done = () => paint();
    save.addEventListener('click', () => {
      const t = ta.value.trim();
      if (t) api.postMessage({ type: 'edit', id: c.id, text: t });
      else done();
    });
    cancel.addEventListener('click', done);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') done();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save.click();
    });
  }

  // ---------------------------------------------------------------- composer

  // GitHub puts the "+" inside the hovered row's own gutter cell, so the pointer
  // never leaves the row on the way to the button. Same idea here: one button per
  // anchorable block, parented to that block, revealed by CSS :hover. Nothing is
  // positioned from mouse coordinates, so it cannot drift or re-target mid-reach.

  // Elements that may not take a <button> child; these get a wrapper instead.
  const NO_CHILD = new Set(['TABLE', 'UL', 'OL', 'DL', 'HR', 'THEAD', 'TBODY', 'TR']);

  function installAddButtons() {
    const all = [...content.querySelectorAll('.ir-block[data-line]')];
    for (const block of all) {
      // Only the innermost block gets a button, so a list shows one per item
      // rather than one for the list and one for each item.
      if (block.querySelector('.ir-block[data-line]')) continue;

      let host = block;
      if (NO_CHILD.has(block.tagName)) {
        const row = document.createElement('div');
        row.className = 'ir-row';
        block.replaceWith(row);
        row.appendChild(block);
        host = row;
      }
      if (host.querySelector(':scope > .ir-add')) continue;

      host.classList.add('ir-anchor');
      const btn = document.createElement('button');
      btn.className = 'ir-add';
      btn.type = 'button';
      btn.textContent = '+';
      btn.title = 'Add a review comment here';
      btn.setAttribute('aria-label', `Add a comment at line ${Number(block.dataset.line) + 1}`);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        compose(block);
      });
      host.appendChild(btn);
    }
  }

  function compose(block) {
    content.querySelectorAll('.ir-composer').forEach((n) => n.remove());
    const box = document.createElement('div');
    box.className = 'ir-composer';

    const quote = String(window.getSelection() || '').trim();
    const ta = document.createElement('textarea');
    ta.placeholder = 'What should change here?';
    if (quote && quote.length < 200) ta.value = `> ${quote}\n\n`;

    const bar = document.createElement('div');
    bar.className = 'ir-bar';
    const save = document.createElement('button');
    save.className = 'primary';
    save.textContent = 'Add comment';
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    const hint = document.createElement('span');
    hint.className = 'ir-hint';
    hint.textContent = '⌘⏎';
    bar.append(save, cancel, hint);

    box.append(ta, bar);
    place(block, box);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    const submit = () => {
      const t = ta.value.trim();
      if (t) api.postMessage({ type: 'add', line: Number(block.dataset.line), text: t });
      box.remove();
    };
    save.addEventListener('click', submit);
    cancel.addEventListener('click', () => box.remove());
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') box.remove();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
    });
  }

  // ---------------------------------------------------------------- links

  content.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href');
    if (href.startsWith('#')) {
      const t = document.getElementById(href.slice(1))
        || content.querySelector(`[name="${CSS.escape(href.slice(1))}"]`);
      if (t) t.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    api.postMessage({ type: 'openLink', href });
  });

  content.addEventListener('dblclick', (e) => {
    const b = e.target.closest('.ir-block[data-line]');
    if (b) api.postMessage({ type: 'openSource', line: Number(b.dataset.line) });
  });

  api.postMessage({ type: 'ready' });
})();
