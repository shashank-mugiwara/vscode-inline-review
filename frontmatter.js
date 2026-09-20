/**
 * YAML frontmatter rendered as a key/value table.
 *
 * markdown-it has no frontmatter rule, so a leading `---` block degrades badly:
 * the opening `---` becomes an <hr>, and the closing one is read as a setext
 * underline, turning the whole metadata blob into one bold <h2>. That is the
 * "header" problem — the fix is to consume the block ourselves and render the
 * pairs as a table, which is what the data actually is.
 */

// `page_id`, `source url`, `title` — a scalar key, optionally with spaces.
const KEY = /^([A-Za-z_][\w.$-]*(?: [\w.$-]+)*)\s*:\s*(.*)$/;
const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/g;

function indentOf(line) {
  return (line.match(/^\s*/) || [''])[0].replace(/\t/g, '  ').length;
}

function unquote(v) {
  const t = v.trim().replace(/,$/, '');
  if (t.length > 1 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Flatten YAML-ish key/value lines into dotted rows. Returns null when the block
 * is not key/value shaped, so the caller can fall back to showing it verbatim.
 */
function parse(src) {
  const rows = [];
  const stack = [];
  let current = null;

  for (const raw of src.split('\n')) {
    const text = raw.trim();
    if (text === '' || text.startsWith('#')) continue;
    const indent = indentOf(raw);

    const item = /^-\s*(.*)$/.exec(text);
    if (item) {
      if (!current) return null;
      current.items.push(unquote(item[1]));
      continue;
    }

    const m = KEY.exec(text);
    if (!m) {
      // A wrapped value — YAML folds long scalars onto the next line.
      if (!current || current.items.length) return null;
      current.value = (current.value ? current.value + ' ' : '') + text;
      continue;
    }

    while (stack.length && indent <= stack[stack.length - 1].indent) stack.pop();
    const key = m[1].trim();
    const value = m[2].trim();
    // Path is built from the stack as it stands, then the key is pushed — otherwise
    // a group header would name itself twice (`labels.labels`).
    current = { key: [...stack.map((s) => s.key), key].join('.'), value, items: [] };
    // `tags: [a, b, c]` is a YAML flow sequence, not a scalar — render it as the
    // list it is rather than printing the brackets.
    const flow = /^\[(.*)\]$/.exec(value);
    if (flow) {
      current.items = flow[1].split(',').map((i) => unquote(i)).filter((i) => i !== '');
      current.value = '';
    }
    rows.push(current);
    if (value === '') stack.push({ indent, key });
  }

  if (!rows.length) return null;

  // Drop bare group headers ("parent:" with children) — the children carry the
  // dotted key already, so the empty row would just be noise.
  const kept = rows.filter((r) =>
    r.value !== '' || r.items.length > 0 || !rows.some((o) => o !== r && o.key.startsWith(r.key + '.')));
  return kept.length ? kept : null;
}

function renderScalar(value, escape) {
  const text = unquote(value);
  if (text === '') return '<span class="ir-fm-empty">—</span>';
  let out = '';
  let last = 0;
  URL_RE.lastIndex = 0;
  let m;
  while ((m = URL_RE.exec(text))) {
    out += escape(text.slice(last, m.index));
    const href = escape(m[0]);
    out += `<a href="${href}" title="${href}">${href}</a>`;
    last = m.index + m[0].length;
  }
  out += escape(text.slice(last));
  return out;
}

function renderCell(row, escape) {
  if (row.items.length) {
    return '<ul class="ir-fm-list">'
      + row.items.map((i) => `<li>${renderScalar(i, escape)}</li>`).join('')
      + '</ul>';
  }
  return renderScalar(row.value, escape);
}

/** @returns {string} HTML for the metadata block, anchorable like any other block. */
function renderTable(src, escape) {
  const rows = parse(src);
  if (!rows) {
    return '<div class="ir-block ir-frontmatter" data-line="0">'
      + `<pre class="ir-fm-raw"><code>${escape(src)}</code></pre></div>`;
  }
  const body = rows.map((r) =>
    `<tr><th scope="row">${escape(r.key)}</th><td>${renderCell(r, escape)}</td></tr>`).join('');
  return '<div class="ir-block ir-frontmatter" data-line="0">'
    + `<details class="ir-fm" open><summary><span class="ir-fm-title">Metadata</span>`
    + `<span class="ir-fm-count">${rows.length} field${rows.length === 1 ? '' : 's'}</span></summary>`
    + `<table class="ir-fm-table"><tbody>${body}</tbody></table></details></div>`;
}

/**
 * Install the block rule. `enabled()` is consulted per render so the setting can
 * be flipped without rebuilding the renderer.
 */
function install(md, enabled) {
  md.block.ruler.before('table', 'ir_frontmatter', (state, startLine, endLine, silent) => {
    if (startLine !== 0 || state.blkIndent !== 0) return false;
    if (!enabled()) return false;
    const open = state.src.slice(state.bMarks[0] + state.tShift[0], state.eMarks[0]).trim();
    if (open !== '---') return false;

    let close = -1;
    for (let line = 1; line < endLine; line++) {
      const t = state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]).trim();
      if (t === '---' || t === '...') { close = line; break; }
    }
    if (close < 1) return false;
    if (silent) return true;

    const body = [];
    for (let i = 1; i < close; i++) body.push(state.src.slice(state.bMarks[i], state.eMarks[i]));
    const token = state.push('ir_frontmatter', '', 0);
    token.content = body.join('\n');
    token.map = [0, close + 1];
    token.markup = '---';
    token.block = true;
    state.line = close + 1;
    return true;
  }, { alt: [] });

  md.renderer.rules.ir_frontmatter = (tokens, idx) =>
    renderTable(tokens[idx].content, md.utils.escapeHtml);
}

module.exports = { install, parse, renderTable };
