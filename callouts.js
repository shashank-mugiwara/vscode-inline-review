/**
 * Obsidian / GitHub callouts: `> [!note] Optional title`.
 *
 * markdown-it renders these as an ordinary blockquote, leaving the `[!note]`
 * marker sitting in the text as literal noise. This consumes the marker and
 * renders a titled, coloured block instead.
 *
 * The `-` and `+` suffixes are Obsidian's fold markers: `-` starts collapsed,
 * `+` starts expanded, neither means "not collapsible".
 */

// tone drives the colour; icon and label are the default header when the
// author gave no title of their own.
const T = (tone, icon, label) => ({ tone, icon, label });

const TYPES = {
  note: T('info', 'ℹ', 'Note'),
  info: T('info', 'ℹ', 'Info'),
  todo: T('info', '○', 'Todo'),
  abstract: T('neutral', '≡', 'Abstract'),
  summary: T('neutral', '≡', 'Summary'),
  tldr: T('neutral', '≡', 'TL;DR'),
  quote: T('neutral', '“', 'Quote'),
  cite: T('neutral', '“', 'Cite'),
  tip: T('tip', '✦', 'Tip'),
  hint: T('tip', '✦', 'Hint'),
  success: T('tip', '✓', 'Success'),
  check: T('tip', '✓', 'Check'),
  done: T('tip', '✓', 'Done'),
  question: T('warn', '?', 'Question'),
  help: T('warn', '?', 'Help'),
  faq: T('warn', '?', 'FAQ'),
  warning: T('warn', '⚠', 'Warning'),
  caution: T('warn', '⚠', 'Caution'),
  attention: T('warn', '⚠', 'Attention'),
  important: T('important', '‼', 'Important'),
  example: T('important', '≣', 'Example'),
  danger: T('danger', '✕', 'Danger'),
  error: T('danger', '✕', 'Error'),
  failure: T('danger', '✕', 'Failure'),
  fail: T('danger', '✕', 'Fail'),
  missing: T('danger', '✕', 'Missing'),
  bug: T('danger', '⚑', 'Bug'),
};

const MARKER = /^\[!([A-Za-z][\w-]*)\]([-+]?)\s*(.*)$/;
const GT = 0x3E;      // >
const SPACE = 0x20;

function rule(state, startLine, endLine, silent) {
  if (!ENABLED()) return false;
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const start = state.bMarks[startLine] + state.tShift[startLine];
  if (state.src.charCodeAt(start) !== GT) return false;

  let head = state.src.slice(start + 1, state.eMarks[startLine]);
  if (head.charCodeAt(0) === SPACE) head = head.slice(1);
  const m = MARKER.exec(head.trim());
  if (!m) return false;                 // a plain blockquote; leave it alone
  const kind = m[1].toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(TYPES, kind)) return false;
  if (silent) return true;

  // Index 0 stands in for the marker line itself. Keeping it means every inner
  // line sits at the same offset it had in the document, so `data-line` anchors
  // (and therefore comments) still point at the right source line.
  const lines = [''];
  let line = startLine + 1;
  for (; line < endLine; line++) {
    if (state.isEmpty(line)) break;
    const s = state.bMarks[line] + state.tShift[line];
    const e = state.eMarks[line];
    if (state.sCount[line] - state.blkIndent < 4 && state.src.charCodeAt(s) === GT) {
      let text = state.src.slice(s + 1, e);
      if (text.charCodeAt(0) === SPACE) text = text.slice(1);
      lines.push(text);
      continue;
    }
    // CommonMark lazy continuation: an unprefixed line still belongs to the
    // paragraph it follows.
    lines.push(state.src.slice(s, e));
  }

  const fold = m[2];
  const open = state.push('ir_callout_open', 'div', 1);
  open.meta = { kind, fold, title: m[3] };
  open.map = [startLine, line];
  open.block = true;

  const oldParent = state.parentType;
  state.parentType = 'blockquote';
  const before = state.tokens.length;
  state.md.block.parse(lines.join('\n'), state.md, state.env, state.tokens);
  for (let i = before; i < state.tokens.length; i++) {
    const t = state.tokens[i];
    if (t.map) t.map = [t.map[0] + startLine, t.map[1] + startLine];
  }
  state.parentType = oldParent;

  const close = state.push('ir_callout_close', 'div', -1);
  close.meta = { fold };
  close.block = true;

  state.line = line;
  return true;
}

/** Consulted per render, so the setting can be flipped without a rebuild. */
let ENABLED = () => true;

function install(md, enabled) {
  if (enabled) ENABLED = enabled;
  md.block.ruler.before('blockquote', 'ir_callout', rule, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  });

  md.renderer.rules.ir_callout_open = (tokens, idx) => {
    const { kind, fold, title } = tokens[idx].meta;
    const type = TYPES[kind];
    const label = md.utils.escapeHtml(title || type.label);
    const cls = `ir-callout ir-cal-${type.tone}`;
    const head = `<span class="ir-callout-icon" aria-hidden="true">${type.icon}</span>`
      + `<span class="ir-callout-title">${label}</span>`;
    if (fold) {
      return `<details class="${cls} ir-callout-fold"${fold === '+' ? ' open' : ''}>`
        + `<summary>${head}</summary><div class="ir-callout-body">`;
    }
    return `<div class="${cls}"><div class="ir-callout-head">${head}</div>`
      + '<div class="ir-callout-body">';
  };

  md.renderer.rules.ir_callout_close = (tokens, idx) =>
    (tokens[idx].meta.fold ? '</div></details>' : '</div></div>');
}

module.exports = { install, TYPES };
