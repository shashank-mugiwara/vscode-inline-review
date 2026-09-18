const { JSDOM } = require('jsdom');
const fs = require('fs');
const EXT = process.env.HOME + '/Documents/GitHub/vscode-inline-review';

const { MarkdownReviewPreview } = require(EXT + '/preview.js');
const md = new MarkdownReviewPreview({ extensionUri: { fsPath: EXT } }, {}).md;

const source = [
  '# Heading', '', 'A paragraph.', '',
  '- first item', '- second item', '',
  '```js', 'const a = 1;', '```', '',
  '> a quote', '',
  '| a | b |', '|---|---|', '| 1 | 2 |', '',
  '```mermaid', 'graph TD;', 'A-->B;', '```', '',
].join('\n');

const dom = new JSDOM(`<!DOCTYPE html><body>
<div id="toolbar">
  <button id="btn-copy"></button><button id="btn-source"></button>
  <span id="nav"><button id="btn-prev"></button><button id="btn-next"></button><button id="btn-list"></button></span>
</div>
<div id="list" hidden></div><div id="rail"></div><div id="content"></div>
</body>`, { runScripts: 'outside-only', pretendToBeVisual: true });

const w = dom.window;
const sent = [];
w.acquireVsCodeApi = () => ({ postMessage: (m) => sent.push(m) });
w.eval(fs.readFileSync(EXT + '/media/preview.js', 'utf8'));

w.dispatchEvent(new w.MessageEvent('message', {
  data: { type: 'update', html: md.render(source), comments: [
    { id: 1, line: 2, endLine: 2, body: 'tighten this' },
    { id: 2, line: 4, endLine: 4, body: 'list note' },
  ] },
}));

const d = w.document;
const ok = (label, cond, extra = '') =>
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);

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
const table = d.querySelector('table');
ok('table wrapped in .ir-row', table && table.parentElement.classList.contains('ir-row'),
   table ? table.parentElement.className : 'no table');

// 5. list items each get their own button, the <ul> does not
const ul = d.querySelector('ul');
ok('<ul> has no button of its own', ul && !ul.querySelector(':scope > .ir-add'));
ok('each <li> has one', [...d.querySelectorAll('li')].every((li) => li.querySelector(':scope > .ir-add')));

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
ok('submitting posts add{line,text}', add && add.line === 5 && add.text === 'second item needs work',
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

// 10. CSS guard: `button:hover` (0-1-1) outranks a bare `.ir-x` (0-1-0) rule, so any
// custom-coloured button needs its own :hover or it repaints grey on hover.
const css = fs.readFileSync(EXT + '/media/preview.css', 'utf8');
for (const sel of ['.ir-add', '.ir-dot']) {
  const rule = new RegExp(`\\${sel}:hover\\s*\\{[^}]*background`, 's');
  ok(`${sel} pins its own hover background`, rule.test(css));
}
