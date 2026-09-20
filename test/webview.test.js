const { JSDOM } = require('jsdom');
const fs = require('fs');
const EXT = __dirname + '/..';

const { MarkdownReviewPreview } = require(EXT + '/preview.js');
const md = new MarkdownReviewPreview({ extensionUri: { fsPath: EXT } }, {}).md;

const source = [
  '---',
  'page_id: "2647654401"',
  'title: "Product Note Sample"',
  'source_url: "https://example.atlassian.net/wiki/spaces/PN/pages/2647654401"',
  'labels:',
  '  - product',
  '  - note',
  'evidence:',
  '  role: "product-intent-and-history"',
  '---',
  '',
  '# Heading', '', 'A paragraph.', '',
  '- first item', '- second item', '',
  '```js', 'const a = 1;', '```', '',
  '> a quote', '',
  '| a | b |', '|---|---|', '| 1 | 2 |', '',
  '```mermaid', 'graph TD;', 'A-->B;', '```', '',
].join('\n');

// The frontmatter block occupies lines 0-9, so document content starts at line 11.
const H1_LINE = 11;

const dom = new JSDOM(`<!DOCTYPE html><body class="vscode-light">
<div id="toolbar">
  <button id="btn-copy-file"></button><button id="btn-copy"></button>
  <button id="btn-source"></button><button id="btn-find"></button>
  <span id="nav"><button id="btn-prev"></button><button id="btn-next"></button><button id="btn-list"></button></span>
</div>
<div id="find" hidden>
  <input id="find-input" type="text" />
  <button id="find-case" class="toggle"></button>
  <button id="find-word" class="toggle"></button>
  <button id="find-regex" class="toggle"></button>
  <span id="find-count"></span>
  <button id="find-prev"></button><button id="find-next"></button><button id="find-close"></button>
</div>
<div id="list" hidden></div>
<div id="zoom" hidden><div id="zoom-stage"></div></div>
<div id="rail"></div><div id="content"></div>
</body>`, { runScripts: 'outside-only', pretendToBeVisual: true });

const w = dom.window;
const sent = [];
w.acquireVsCodeApi = () => ({ postMessage: (m) => sent.push(m) });
w.eval(fs.readFileSync(EXT + '/media/preview.js', 'utf8'));

w.dispatchEvent(new w.MessageEvent('message', {
  data: {
    type: 'update',
    html: md.render(source),
    settings: { codeBlockChrome: true, mermaidHeight: 520 },
    comments: [
      { id: 1, line: H1_LINE + 2, endLine: H1_LINE + 2, body: 'tighten this' },
      { id: 2, line: H1_LINE + 4, endLine: H1_LINE + 4, body: 'list note' },
    ],
  },
}));

const d = w.document;
let failures = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
};

// ---------------------------------------------------------------- composer

const buttons = [...d.querySelectorAll('.ir-add')];
ok('every block has an add button', buttons.length > 0, `${buttons.length} buttons`);

// 1. one button per innermost block, never on a container that holds another block
const innermost = [...d.querySelectorAll('.ir-block[data-line]')].filter((e) => !e.querySelector('.ir-block[data-line]'));
ok('one button per innermost block', buttons.length === innermost.length,
   `${buttons.length} buttons vs ${innermost.length} innermost`);

// 2. THE BUG: the button must be a DESCENDANT of its hover target
const orphan = buttons.filter((b) => {
  const host = b.parentElement;
  return !host.classList.contains('ir-anchor') && !host.classList.contains('ir-row');
});
ok('every button is a child of its hover target', orphan.length === 0,
   orphan.length ? orphan.map((o) => o.parentElement.tagName).join(',') : '');

// 3. no invalid DOM: a button must never be a direct child of table/ul/ol
const illegal = buttons.filter((b) => ['TABLE','UL','OL','TR','TBODY','THEAD'].includes(b.parentElement.tagName));
ok('no button parented to table/list internals', illegal.length === 0,
   illegal.map((b) => b.parentElement.tagName).join(','));

// 4. the table got wrapped rather than injected into
const table = d.querySelector('#content > .ir-row > table, #content table.ir-block');
ok('body table wrapped in .ir-row', table && table.parentElement.classList.contains('ir-row'),
   table ? table.parentElement.className : 'no table');

// 5. list items each get their own button, the <ul> does not
const ul = d.querySelector('#content > ul, #content ul.ir-block');
ok('<ul> has no button of its own', ul && !ul.querySelector(':scope > .ir-add'));
// (frontmatter's own value list is chrome, not a commentable document block)
ok('each document <li> has one',
   [...d.querySelectorAll('li')].filter((li) => !li.closest('.ir-fm-list'))
     .every((li) => li.querySelector(':scope > .ir-add')));

// 6. mermaid block is anchorable too
const mm = d.querySelector('pre.ir-mermaid');
ok('mermaid block has a button', mm && mm.closest('[data-line]').querySelector('.ir-add'));

// 7. clicking opens a composer, and submitting posts the right line
const liBtn = d.querySelectorAll('li .ir-add')[1];
liBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const composer = d.querySelector('.ir-composer');
ok('click opens a composer', !!composer);
if (composer) {
  composer.querySelector('textarea').value = 'second item needs work';
  [...composer.querySelectorAll('button')].find((b) => b.textContent === 'Add comment')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
}
const add = sent.find((m) => m.type === 'add');
ok('submitting posts add{line,text}', add && add.line === H1_LINE + 5 && add.text === 'second item needs work',
   JSON.stringify(add));

// 8. comment cards rendered and indexed
ok('comment cards painted', d.querySelectorAll('.ir-card').length === 2);
ok('rail dot per comment', d.querySelectorAll('#rail .ir-dot').length === 2);
ok('dropdown entry per comment', d.querySelectorAll('#list .ir-list-item').length === 2);
ok('count button labelled', d.getElementById('btn-list').textContent === '2 comments',
   d.getElementById('btn-list').textContent);

// 9. comment cards must not be mistaken for renderer blocks
const cardsAsBlocks = [...d.querySelectorAll('.ir-card')].filter((c) => c.hasAttribute('data-line'));
ok('cards do not carry data-line', cardsAsBlocks.length === 0);
ok('anchor query ignores cards',
   [...d.querySelectorAll('.ir-block[data-line]')].every((e) => !e.classList.contains('ir-card')));

// ---------------------------------------------------------------- [1] frontmatter

const fm = d.querySelector('.ir-frontmatter table.ir-fm-table');
ok('frontmatter renders as a table', !!fm);
const keys = fm ? [...fm.querySelectorAll('th')].map((t) => t.textContent) : [];
ok('every scalar key is a row', keys.includes('page_id') && keys.includes('title')
   && keys.includes('evidence.role'), keys.join(','));
ok('a bare group header is not its own row', !keys.includes('evidence'), keys.join(','));
ok('list values render as a list', !!fm && fm.querySelectorAll('.ir-fm-list li').length === 2);
ok('url values become links',
   !!fm && /atlassian\.net/.test(fm.querySelector('a')?.getAttribute('href') || ''));
ok('frontmatter did not become an <hr> + heading',
   d.querySelectorAll('#content > hr').length === 0
   && !/page_id/.test(d.querySelector('#content h1')?.textContent || ''));
ok('frontmatter block is commentable', !!d.querySelector('.ir-frontmatter .ir-add'));

// ---------------------------------------------------------------- [2] code blocks

const code = d.querySelector('.ir-code[data-lang="js"]');
ok('fence wrapper carries its language', !!code, code ? code.dataset.lang : 'missing');
ok('fence is highlighted with hljs classes',
   !!code && code.querySelectorAll('.hljs-keyword, .hljs-number, .hljs-title').length > 0,
   code ? code.querySelector('code')?.innerHTML : '');
ok('code block gets a language label',
   !!code && code.querySelector('.ir-code-lang')?.textContent === 'js');
const copyBtn = code && code.querySelector('.ir-code-copy');
ok('code block gets a copy button', !!copyBtn);
if (copyBtn) copyBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const copied = sent.find((m) => m.type === 'copyCode');
ok('copy button posts the block source', copied && copied.text.trim() === 'const a = 1;',
   JSON.stringify(copied));
ok('mermaid fence is not given code chrome', !!mm && !mm.closest('.ir-code'));

// the palette must define its tokens for BOTH themes, or a light editor gets
// dark-theme colours (the original bug: debug-panel variables only)
const css = fs.readFileSync(EXT + '/media/preview.css', 'utf8');
for (const v of ['--ir-hl-keyword', '--ir-hl-string', '--ir-hl-comment', '--ir-code-bg']) {
  const light = new RegExp(`^body\\s*\\{[^}]*${v}:`, 'sm').test(css);
  const dark = new RegExp(`body\\.vscode-dark[^{]*\\{[^}]*${v}:`, 's').test(css);
  ok(`${v} defined for light and dark`, light && dark, `light=${light} dark=${dark}`);
}

// ---------------------------------------------------------------- [3] find

const findEl = d.getElementById('find');
const findInput = d.getElementById('find-input');
d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true }));
ok('cmd+F opens the find bar', findEl.hidden === false);

const typeAndSearch = (value) => {
  findInput.value = value;
  findInput.dispatchEvent(new w.Event('input', { bubbles: true }));
  return new Promise((r) => setTimeout(r, 140));
};

(async () => {
  await typeAndSearch('item');
  ok('literal search counts matches', /of 2$/.test(d.getElementById('find-count').textContent),
     d.getElementById('find-count').textContent);

  d.getElementById('find-regex').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await typeAndSearch('(first|second) item');
  ok('regex toggle turns on', d.getElementById('find-regex').classList.contains('on'));
  ok('regex search counts matches', /of 2$/.test(d.getElementById('find-count').textContent),
     d.getElementById('find-count').textContent);

  await typeAndSearch('(unclosed');
  ok('an invalid regex is reported, not thrown',
     findEl.classList.contains('invalid')
     && d.getElementById('find-count').textContent === 'Bad pattern');

  d.getElementById('find-regex').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await typeAndSearch('HEADING');
  ok('search is case-insensitive by default', /of 1$/.test(d.getElementById('find-count').textContent),
     d.getElementById('find-count').textContent);
  d.getElementById('find-case').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  ok('match-case narrows it to nothing',
     d.getElementById('find-count').textContent === 'No results',
     d.getElementById('find-count').textContent);

  d.getElementById('find-case').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await typeAndSearch('item');
  d.getElementById('find-word').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  ok('whole-word still matches a standalone word',
     /of 2$/.test(d.getElementById('find-count').textContent),
     d.getElementById('find-count').textContent);

  // searching reaches frontmatter values and code, not just prose
  d.getElementById('find-word').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await typeAndSearch('2647654401');
  ok('find reaches frontmatter values', /of 2$/.test(d.getElementById('find-count').textContent),
     d.getElementById('find-count').textContent);
  await typeAndSearch('const a');
  ok('find reaches code blocks', /of 1$/.test(d.getElementById('find-count').textContent),
     d.getElementById('find-count').textContent);

  d.getElementById('find-close').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  ok('close hides the find bar', findEl.hidden === true);

  // ------------------------------------------------------------- [4] copy all files
  sent.length = 0;
  d.getElementById('btn-copy-file').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  d.getElementById('btn-copy').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  ok('toolbar offers per-file copy', sent.some((m) => m.type === 'copyFile'));
  ok('toolbar offers across-all-files copy', sent.some((m) => m.type === 'copyAll'));

  const pkg = JSON.parse(fs.readFileSync(EXT + '/package.json', 'utf8'));
  const titles = pkg.contributes.commands.map((c) => `${c.category || ''}: ${c.title}`);
  ok('a command copies across all files',
     titles.includes('Inline Review: Copy Comments Across All Files'), titles.join(' | '));
  ok('copyFileComments is registered',
     fs.readFileSync(EXT + '/extension.js', 'utf8').includes("reg('inlineReview.copyFileComments'"));

  // ------------------------------------------------------------- callouts
  // `> [!note] Title` used to render as a blockquote with the marker left in
  // the text. 12 types appear across the user's docs, ~1,700 of them collapsed.
  const cal = md.render([
    '> [!note] A titled note',
    '> body text',
    '',
    '> [!note]- Collapsed',
    '> hidden',
    '',
    '> [!tip]+ Open but foldable',
    '> shown',
    '',
    '> [!warning]',
    '> no title',
    '',
    '> [!danger] Boom',
    '> bad',
    '',
    '> [!nonsense] Not a callout type',
    '> stays a quote',
    '',
    '> just an ordinary quote',
    '',
  ].join('\n'));

  // (the deliberate `[!nonsense]` below is excluded: an unknown type must be left alone)
  ok('callout marker is consumed, not printed',
     !/\[!(note|tip|warning|danger)\]/.test(cal), cal.slice(0, 120));
  ok('a titled callout keeps its title', cal.includes('>A titled note<'));
  ok('an untitled callout falls back to the type name', cal.includes('>Warning<'));
  ok('tone class is applied', cal.includes('ir-cal-info') && cal.includes('ir-cal-danger')
     && cal.includes('ir-cal-warn'), '');
  ok('`-` renders a collapsed <details>',
     /<details class="ir-callout ir-cal-info ir-callout-fold"><summary>/.test(cal)
     && !/ir-callout-fold" open/.test(cal.split('Collapsed')[0].slice(-120)));
  ok('`+` renders an open <details>', /ir-callout-fold" open>/.test(cal));
  ok('a plain callout is not a <details>',
     cal.includes('<div class="ir-callout ir-cal-warn"><div class="ir-callout-head">'));
  ok('an unknown type stays an ordinary blockquote',
     /<blockquote[ >]/.test(cal) && cal.includes('[!nonsense]'));
  ok('an ordinary blockquote is untouched',
     (cal.match(/<blockquote[ >]/g) || []).length === 2,
     String((cal.match(/<blockquote[ >]/g) || []).length));
  ok('blockquotes stay commentable', /<blockquote data-line="\d+"/.test(cal));

  // The big one: comments anchor by source line, so inner blocks must keep the
  // line numbers they had in the document, not the offsets of the stripped body.
  const anchored = md.render([
    '# H', '', 'para', '',
    '> [!note] Titled',
    '> inside the callout',
    '>',
    '> second para',
    '',
    'after',
    '',
  ].join('\n'));
  ok('callout body keeps document line numbers',
     anchored.includes('data-line="5"') && anchored.includes('data-line="7"')
     && anchored.includes('data-line="9"'),
     (anchored.match(/data-line="\d+"/g) || []).join(','));
  ok('callout body blocks stay commentable', /ir-callout-body"><p data-line="5"/.test(anchored));

  for (const tone of ['info', 'tip', 'warn', 'danger', 'important', 'neutral']) {
    ok(`tone ${tone} has a colour in both themes`,
       new RegExp(`^body\\s*\\{[^}]*--ir-tone-${tone}:`, 'sm').test(css)
       && new RegExp(`body\\.vscode-dark[^{]*\\{[^}]*--ir-tone-${tone}:`, 's').test(css));
  }

  // ------------------------------------------------------------- blockquotes
  // `padding: 0 1em` left the text jammed against the band edges, and the
  // theme's own quote border is often invisible against its own background.
  // strip comments first: the rule documents the old `padding: 0 1em` it replaced
  const cssBare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const bq = /^#content blockquote \{[^}]*\}/sm.exec(cssBare);
  ok('blockquote has vertical padding', !!bq && !/padding:\s*0 /.test(bq[0]), bq && bq[0]);
  ok('blockquote rule uses our own token', !!bq && bq[0].includes('var(--ir-quote-rule)'));
  ok('blockquote is no longer dimmed', !!bq && !bq[0].includes('opacity'));

  // ------------------------------------------------------------- frontmatter flow seq
  const flow = require(EXT + '/frontmatter.js').parse(
    'title: "T"\ntags: [onboarding, domain-primer]\naudience: [backend]');
  ok('a YAML flow sequence becomes a list',
     flow[1].items.length === 2 && flow[1].value === '' && flow[2].items.length === 1,
     JSON.stringify(flow));

  // ------------------------------------------------------------- [5] mermaid zoom
  // jsdom cannot run mermaid, so assert the mount contract the renderer relies on.
  const js = fs.readFileSync(EXT + '/media/preview.js', 'utf8');
  for (const need of ['ir-mm-viewport', 'ir-mm-canvas', 'ir-mm-tools', 'function panZoom',
                      'function expandZoom', 'function collapseZoom']) {
    ok(`zoom: ${need} present`, js.includes(need));
  }
  ok('zoom: wheel handler is non-passive so it can preventDefault',
     /addEventListener\('wheel'[\s\S]{0,2200}\{ passive: false \}/.test(js));
  ok('zoom: pointer drag pans', js.includes("addEventListener('pointermove'"));
  ok('zoom: overlay exists in the shell',
     fs.readFileSync(EXT + '/preview.js', 'utf8').includes('id="zoom-stage"'));
  for (const sel of ['.ir-mm-viewport', '.ir-mm-canvas', '#zoom']) {
    ok(`zoom: ${sel} styled`, css.includes(sel));
  }

  // THE FIT BUG: measuring with clientWidth/clientHeight reported the box as it
  // was BEFORE the element was reparented into the overlay, so expanding left the
  // diagram at the inline scale and Fit looked broken.
  ok('zoom: fit measures a flushed layout, not stale client metrics',
     /function box\(\)[\s\S]{0,300}getBoundingClientRect/.test(js)
     && /function fit\(\)[\s\S]{0,200}box\(\)/.test(js));
  ok('zoom: no clientWidth/clientHeight left in the transform maths',
     !/state\.[xy] = .*client(Width|Height)/.test(js)
     && !/\(viewport\.clientWidth - pad\)/.test(js));
  ok('zoom: a viewport resize re-fits', js.includes('ResizeObserver'));
  ok('zoom: a hand-chosen scale survives a resize', js.includes('userZoomed'));
  ok('zoom: expand/collapse fit immediately, not on a later frame',
     !js.includes('requestAnimationFrame(() => requestAnimationFrame'));
  ok('zoom: mermaidHeight is a cap, not a fixed height',
     /clamp\(Math\.round\(h \* scale\)/.test(js));

  // 10. CSS guard: `button:hover` (0-1-1) outranks a bare `.ir-x` (0-1-0) rule, so any
  // custom-coloured button needs its own :hover or it repaints grey on hover.
  for (const sel of ['.ir-add', '.ir-dot']) {
    const rule = new RegExp(`\\${sel}:hover\\s*\\{[^}]*background`, 's');
    ok(`${sel} pins its own hover background`, rule.test(css));
  }

  console.log(failures ? `\n${failures} FAILING` : '\nall green');
  process.exit(failures ? 1 : 0);
})();
