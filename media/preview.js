(function () {
  const api = acquireVsCodeApi();
  const content = document.getElementById('content');
  const listEl = document.getElementById('list');
  const railEl = document.getElementById('rail');
  const btnList = document.getElementById('btn-list');
  const zoomEl = document.getElementById('zoom');
  const zoomStage = document.getElementById('zoom-stage');
  let comments = [];
  let cards = [];      // {id, line, el} in document order
  let cursor = -1;
  let settings = { codeBlockChrome: true, mermaidHeight: 520 };

  // ---------------------------------------------------------------- plumbing

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'update') {
      if (m.settings) settings = Object.assign(settings, m.settings);
      collapseZoom();
      content.innerHTML = m.html;
      comments = m.comments || [];
      decorateCode();
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
  document.getElementById('btn-copy-file').addEventListener('click', () => {
    api.postMessage({ type: 'copyFile' });
  });
  document.getElementById('btn-source').addEventListener('click', () => {
    api.postMessage({ type: 'openSource', line: currentLine() });
  });
  document.getElementById('btn-find').addEventListener('click', () => openFind());
  document.getElementById('btn-prev').addEventListener('click', () => step(-1));
  document.getElementById('btn-next').addEventListener('click', () => step(1));
  btnList.addEventListener('click', () => {
    listEl.hidden = !listEl.hidden;
  });

  document.addEventListener('keydown', (e) => {
    // Find is reachable from anywhere, including from inside the find box itself,
    // so it is handled before the "user is typing" bail-out below.
    const key = (e.key || '').toLowerCase();
    if ((e.metaKey || e.ctrlKey) && key === 'f' && !e.altKey) {
      e.preventDefault();
      openFind();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && key === 'g') {
      e.preventDefault();
      if (findHits.length) goToHit(findIndex + (e.shiftKey ? -1 : 1));
      return;
    }
    if (e.key === 'Escape') {
      if (!zoomEl.hidden) { e.preventDefault(); collapseZoom(); return; }
      if (!findEl.hidden) { e.preventDefault(); closeFind(); return; }
    }

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

  // ---------------------------------------------------------------- find
  //
  // VS Code's native webview find widget only does literal, case-insensitive
  // substring search, so this is our own: regex, case, whole word, match count
  // and next/previous. Matches are painted with the CSS Custom Highlight API,
  // which takes Ranges and never touches the DOM — so a hit spanning inline
  // markup still highlights, and nothing the composer or the comment cards rely
  // on gets rewritten underneath them.

  const findEl = document.getElementById('find');
  const findInput = document.getElementById('find-input');
  const findCount = document.getElementById('find-count');
  const findToggles = {
    case: document.getElementById('find-case'),
    word: document.getElementById('find-word'),
    regex: document.getElementById('find-regex'),
  };
  const HAS_HIGHLIGHT = typeof CSS !== 'undefined'
    && !!CSS.highlights && typeof window.Highlight === 'function';
  const MAX_HITS = 5000;

  let findHits = [];
  let findIndex = -1;
  const findOpts = { case: false, word: false, regex: false };

  for (const [name, btn] of Object.entries(findToggles)) {
    if (!btn) continue;
    btn.addEventListener('click', () => {
      findOpts[name] = !findOpts[name];
      btn.classList.toggle('on', findOpts[name]);
      btn.setAttribute('aria-pressed', String(findOpts[name]));
      runFind();
      findInput.focus();
    });
  }
  document.getElementById('find-next')?.addEventListener('click', () => goToHit(findIndex + 1));
  document.getElementById('find-prev')?.addEventListener('click', () => goToHit(findIndex - 1));
  document.getElementById('find-close')?.addEventListener('click', () => closeFind());

  let findTimer;
  findInput?.addEventListener('input', () => {
    clearTimeout(findTimer);
    findTimer = setTimeout(() => runFind(), 90);
  });
  findInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!findHits.length) runFind();
      else goToHit(findIndex + (e.shiftKey ? -1 : 1));
    }
  });

  function openFind() {
    findEl.hidden = false;
    const sel = String(window.getSelection() || '').trim();
    if (sel && sel.length < 200 && !sel.includes('\n')) findInput.value = sel;
    findInput.focus();
    findInput.select();
    if (findInput.value) runFind();
  }

  function closeFind() {
    findEl.hidden = true;
    clearHighlights();
    findHits = [];
    findIndex = -1;
  }

  /** Flat text of the rendered document, with an index back to the text nodes. */
  function textMap() {
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        // Chrome does not paint highlights inside <svg>, and the tool bars are
        // chrome rather than document text.
        if (p.closest('svg, script, style, .ir-code-tools, .ir-mm-tools, .ir-composer')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let text = '';
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) {
      nodes.push({ node: n, start: text.length });
      text += n.nodeValue;
    }
    return { text, nodes };
  }

  function locate(nodes, offset) {
    let lo = 0;
    let hi = nodes.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (nodes[mid].start <= offset) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const e = nodes[ans];
    return { node: e.node, offset: Math.max(0, Math.min(offset - e.start, e.node.nodeValue.length)) };
  }

  function buildRegex(q) {
    const src = findOpts.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const body = findOpts.word ? `\\b(?:${src})\\b` : src;
    return new RegExp(body, findOpts.case ? 'g' : 'gi');
  }

  function runFind() {
    const q = findInput ? findInput.value : '';
    clearHighlights();
    findHits = [];
    findEl.classList.remove('invalid');
    if (!q) { findIndex = -1; updateFindCount(); return; }

    let re;
    try {
      re = buildRegex(q);
    } catch (_) {
      findEl.classList.add('invalid');
      findIndex = -1;
      findCount.textContent = 'Bad pattern';
      return;
    }

    const { text, nodes } = textMap();
    if (nodes.length) {
      let m;
      while (findHits.length < MAX_HITS && (m = re.exec(text)) !== null) {
        if (m[0] === '') { re.lastIndex++; continue; }  // a regex that can match nothing
        const a = locate(nodes, m.index);
        const b = locate(nodes, m.index + m[0].length);
        try {
          const r = document.createRange();
          r.setStart(a.node, a.offset);
          r.setEnd(b.node, b.offset);
          findHits.push(r);
        } catch (_) { /* node detached mid-scan; skip it */ }
      }
    }

    if (!findHits.length) { findIndex = -1; updateFindCount(); return; }
    // Keep the reader near where they were rather than snapping to the top.
    findIndex = Math.max(0, findHits.findIndex((r) => {
      const rect = rectOf(r);
      return !rect || rect.bottom > 0;
    }));
    goToHit(findIndex, true);
  }

  /** jsdom, and older engines, do not implement Range.getBoundingClientRect. */
  function rectOf(r) {
    try {
      return typeof r.getBoundingClientRect === 'function' ? r.getBoundingClientRect() : null;
    } catch (_) {
      return null;
    }
  }

  function goToHit(i, quiet) {
    if (!findHits.length) { updateFindCount(); return; }
    findIndex = ((i % findHits.length) + findHits.length) % findHits.length;
    const r = findHits[findIndex];
    paintHighlights();
    updateFindCount();
    const rect = rectOf(r);
    const host = r.startContainer.parentElement;
    if (rect && (rect.height || rect.width)) {
      if (!quiet || rect.top < 60 || rect.bottom > window.innerHeight - 40) {
        window.scrollTo({
          top: Math.max(0, window.scrollY + rect.top - window.innerHeight / 2),
          behavior: 'smooth',
        });
      }
    } else if (host) {
      host.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    // Without the Highlight API there is nothing painted, so flash the host
    // element instead of leaving the jump unexplained.
    if (!HAS_HIGHLIGHT && host) flash(host);
  }

  function paintHighlights() {
    if (!HAS_HIGHLIGHT) return;
    const rest = findHits.filter((_, i) => i !== findIndex);
    const cur = findHits[findIndex] ? [findHits[findIndex]] : [];
    CSS.highlights.set('ir-find', new window.Highlight(...rest));
    CSS.highlights.set('ir-find-current', new window.Highlight(...cur));
  }

  function clearHighlights() {
    if (!HAS_HIGHLIGHT) return;
    CSS.highlights.delete('ir-find');
    CSS.highlights.delete('ir-find-current');
  }

  function updateFindCount() {
    if (!findCount) return;
    if (!findHits.length) {
      findCount.textContent = findInput && findInput.value ? 'No results' : '';
      return;
    }
    const capped = findHits.length >= MAX_HITS ? '+' : '';
    findCount.textContent = `${findIndex + 1} of ${findHits.length}${capped}`;
  }

  /** Ranges do not survive a re-render, so re-scan whenever the DOM is rebuilt. */
  function refreshFind() {
    if (findEl.hidden || !findInput.value) return;
    runFind();
  }

  // ---------------------------------------------------------------- code blocks

  function decorateCode() {
    if (!settings.codeBlockChrome) return;
    for (const block of content.querySelectorAll('.ir-code')) {
      if (block.querySelector(':scope > .ir-code-tools')) continue;
      const code = block.querySelector('pre > code');
      if (!code) continue;

      const tools = document.createElement('div');
      tools.className = 'ir-code-tools';
      const lang = document.createElement('span');
      lang.className = 'ir-code-lang';
      lang.textContent = block.dataset.lang || 'text';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'ir-code-copy';
      copy.textContent = 'Copy';
      copy.addEventListener('click', (e) => {
        e.stopPropagation();
        api.postMessage({ type: 'copyCode', text: code.textContent });
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
      });
      tools.append(lang, copy);
      block.insertBefore(tools, block.firstChild);
      block.classList.add('ir-code-chrome');
    }
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
    collapseZoom();
    content.querySelectorAll('.ir-mermaid-msg').forEach((n) => n.remove());
    const nodes = [...content.querySelectorAll('pre.ir-mermaid')];
    for (const n of nodes) {
      if (!n.dataset.src) continue;
      n.irZoom = null;
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
    if (!nodes.length) { refreshFind(); return; }
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
        mountDiagram(n, svg);
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
    refreshFind();
  }

  function fail(node, message, src) {
    node.classList.add('ir-mermaid-error');
    if (src !== undefined) node.textContent = src;
    const msg = document.createElement('div');
    msg.className = 'ir-mermaid-msg';
    msg.textContent = 'Mermaid: ' + message;
    node.after(msg);
  }

  /**
   * A rendered diagram is put inside a fixed-height viewport with its own
   * pan/zoom transform, so a large graph stays navigable instead of being
   * squashed to the column width.
   */
  function mountDiagram(pre, svgMarkup) {
    pre.textContent = '';
    pre.classList.remove('ir-mermaid-error');
    pre.classList.add('ir-mermaid-done');

    const viewport = document.createElement('div');
    viewport.className = 'ir-mm-viewport';
    const canvas = document.createElement('div');
    canvas.className = 'ir-mm-canvas';
    canvas.innerHTML = svgMarkup;
    viewport.appendChild(canvas);

    // Mermaid pins an inline max-width that would fight the zoom transform.
    const svg = canvas.querySelector('svg');
    let w = 800;
    let h = 600;
    if (svg) {
      const vb = svg.viewBox && svg.viewBox.baseVal;
      const box = svg.getBoundingClientRect();
      w = (vb && vb.width) || box.width || w;
      h = (vb && vb.height) || box.height || h;
      svg.removeAttribute('style');
      svg.setAttribute('width', String(w));
      svg.setAttribute('height', String(h));
    }
    canvas.dataset.w = String(w);
    canvas.dataset.h = String(h);

    const tools = document.createElement('div');
    tools.className = 'ir-mm-tools';
    const readout = document.createElement('button');
    readout.type = 'button';
    readout.className = 'ir-mm-readout';
    readout.title = 'Reset to 100%';

    const mk = (label, title, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      return b;
    };

    pre.append(tools, viewport);
    const ctl = panZoom(viewport, canvas, readout);
    pre.irZoom = ctl;

    tools.append(
      mk('−', 'Zoom out', () => ctl.zoomBy(1 / 1.25)),
      readout,
      mk('+', 'Zoom in', () => ctl.zoomBy(1.25)),
      mk('Fit', 'Fit the whole diagram in view', () => ctl.fit()),
      mk('⤡', 'Expand to full window', () => expandZoom(pre)),
    );
    readout.addEventListener('click', (e) => { e.stopPropagation(); ctl.reset(); });

    // mermaidHeight is a ceiling, not a fixed height: a short, wide diagram gets
    // only the room it needs instead of sitting in a tall box of dead space.
    const avail = viewport.clientWidth || 800;
    const scale = Math.min(1, (avail - 16) / w);
    viewport.style.height =
      `${clamp(Math.round(h * scale) + 16, 180, Math.max(180, settings.mermaidHeight))}px`;

    ctl.fit();
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function panZoom(viewport, canvas, readout) {
    const state = { k: 1, x: 0, y: 0 };
    const MIN = 0.05;
    const MAX = 10;
    // Set once the reader zooms by hand, so an automatic re-fit (the overlay
    // opening, the window resizing) never overrides a scale they chose.
    let userZoomed = false;

    const size = () => ({
      w: Number(canvas.dataset.w) || 1,
      h: Number(canvas.dataset.h) || 1,
    });

    /** Reading a layout property flushes any pending style/layout work, so this
     *  reports the box as it is now rather than as it was before the element was
     *  reparented into (or out of) the overlay. */
    function box() {
      const r = viewport.getBoundingClientRect();
      return {
        w: Math.round(r.width) || viewport.clientWidth || 1,
        h: Math.round(r.height) || viewport.clientHeight || 1,
      };
    }

    function apply() {
      canvas.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.k})`;
      if (readout) readout.textContent = `${Math.round(state.k * 100)}%`;
    }

    function centre() {
      const { w, h } = size();
      const v = box();
      state.x = Math.max(0, (v.w - w * state.k) / 2);
      state.y = Math.max(0, (v.h - h * state.k) / 2);
    }

    function fit() {
      const { w, h } = size();
      const v = box();
      const pad = 16;
      state.k = clamp(Math.min((v.w - pad) / w, (v.h - pad) / h, 1), MIN, MAX);
      userZoomed = false;
      centre();
      apply();
    }

    function reset() {
      state.k = 1;
      userZoomed = true;
      centre();
      apply();
    }

    function zoomAt(factor, cx, cy) {
      const next = clamp(state.k * factor, MIN, MAX);
      if (next === state.k) return;
      userZoomed = true;
      const ratio = next / state.k;
      state.x = cx - (cx - state.x) * ratio;
      state.y = cy - (cy - state.y) * ratio;
      state.k = next;
      apply();
    }

    function zoomBy(factor) {
      const v = box();
      zoomAt(factor, v.w / 2, v.h / 2);
    }

    // The viewport changes size when the diagram is expanded to the overlay,
    // collapsed back, when the window resizes, and when the reader drags the
    // resize grip. Re-fitting here is what keeps the scale honest; waiting a
    // frame or two after the move is not reliable, because the first frames
    // still report the old box.
    if (typeof ResizeObserver === 'function') {
      let last = '';
      const ro = new ResizeObserver(() => {
        const v = box();
        const key = `${v.w}x${v.h}`;
        if (key === last) return;
        last = key;
        if (userZoomed) apply();
        else fit();
      });
      ro.observe(viewport);
    }

    viewport.addEventListener('wheel', (e) => {
      const { w, h } = size();
      const v = box();
      if (e.ctrlKey || e.metaKey) {
        const r = viewport.getBoundingClientRect();
        zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top);
        e.preventDefault();
        return;
      }
      // Pan inside the diagram while there is somewhere to go, then hand the
      // wheel back to the page so the document never becomes a scroll trap.
      const sw = w * state.k;
      const sh = h * state.k;
      if (e.shiftKey && sw > v.w) {
        const nx = clamp(state.x - e.deltaY, v.w - sw, 0);
        if (nx !== state.x) { state.x = nx; apply(); e.preventDefault(); }
        return;
      }
      if (sh <= v.h) return;
      const ny = clamp(state.y - e.deltaY, v.h - sh, 0);
      if (ny === state.y) return;
      state.y = ny;
      apply();
      e.preventDefault();
    }, { passive: false });

    let drag = null;
    viewport.addEventListener('pointerdown', (e) => {
      userZoomed = true;   // a deliberate pan is a chosen view, same as a zoom
      if (e.button !== 0 || e.target.closest('a')) return;
      drag = { x: e.clientX, y: e.clientY, ox: state.x, oy: state.y };
      viewport.setPointerCapture(e.pointerId);
      viewport.classList.add('dragging');
    });
    viewport.addEventListener('pointermove', (e) => {
      if (!drag) return;
      state.x = drag.ox + (e.clientX - drag.x);
      state.y = drag.oy + (e.clientY - drag.y);
      apply();
    });
    const endDrag = (e) => {
      if (!drag) return;
      drag = null;
      viewport.classList.remove('dragging');
      try { viewport.releasePointerCapture(e.pointerId); } catch (_) { /* already gone */ }
    };
    viewport.addEventListener('pointerup', endDrag);
    viewport.addEventListener('pointercancel', endDrag);
    viewport.addEventListener('dblclick', (e) => { e.preventDefault(); fit(); });

    return { fit, reset, zoomBy, apply };
  }

  /** Move a diagram into a full-window overlay; the element itself is reused so
   *  the source, the pan/zoom controller and the comment anchor all survive. */
  function expandZoom(pre) {
    if (!zoomEl || !zoomStage) return;
    collapseZoom();
    const holder = document.createElement('div');
    holder.className = 'ir-mm-placeholder';
    pre.replaceWith(holder);
    pre.irHolder = holder;
    pre.classList.add('ir-mm-full');
    zoomStage.appendChild(pre);
    zoomEl.hidden = false;
    if (pre.irZoom) pre.irZoom.fit();
  }

  function collapseZoom() {
    if (!zoomEl || zoomEl.hidden) return;
    const pre = zoomStage.firstElementChild;
    zoomEl.hidden = true;
    if (!pre) return;
    pre.classList.remove('ir-mm-full');
    if (pre.irHolder && pre.irHolder.parentNode) pre.irHolder.replaceWith(pre);
    pre.irHolder = null;
    if (pre.irZoom) pre.irZoom.fit();
  }

  zoomEl?.addEventListener('pointerdown', (e) => {
    if (e.target === zoomEl) collapseZoom();
  });

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
    refreshFind();
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
    // A diagram's own double-click means "fit", not "open the source".
    if (e.target.closest('.ir-mm-viewport')) return;
    const b = e.target.closest('.ir-block[data-line]');
    if (b) api.postMessage({ type: 'openSource', line: Number(b.dataset.line) });
  });

  api.postMessage({ type: 'ready' });
})();
