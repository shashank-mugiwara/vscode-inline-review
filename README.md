# Inline Review

Review markdown **in the rendered view**, leave inline comments on any block, then
copy every comment at once as `file` + `line` notes to hand to Claude Code.

Built for people using the Claude Code extension in VS Code, but it has no hard
dependency on it — the output is plain markdown on your clipboard.

## Why it exists

Claude Code's VS Code extension has no way to take inline review comments:

- Its bundle contains **no Comments API surface at all** — zero references to
  `CommentController`, `CommentThread` or `commentingRangeProvider`.
- Every one of its commands is zero-argument, deriving context from the active
  editor's selection, so nothing can be handed to it programmatically.
- The "add inline comments" affordance people remember is plan mode opening the
  *plan* as an editable markdown document — it does not generalise to your files.

VS Code's built-in markdown preview cannot host comments either. Its
`contributes.markdown.previewScripts` extension point will happily inject UI, but
there is no return channel: `postMessage` is delivered to the owning extension
(`markdown-language-features`), the preview CSP is `default-src 'none'` with **no**
`connect-src` so fetch/XHR/WebSocket are blocked, and `command:` URIs are disabled.
UI injected there would be a dead prop.

So this ships its own preview, which it owns end to end.

## Two ways to comment

**In the preview.** Hover any block, click the `+` in the gutter, type, `⌘⏎`.
The comment renders as a card under the block it belongs to.

**In the source.** Hover the gutter of a markdown text editor and click `+`, or put
the cursor on a line and press `⌘K C`.

Both write to one store, so comments made either way appear in the other and in
VS Code's built-in **Comments** panel.

## Finding them again

- **Sidebar** — *Review Comments* in the Explorer lists every comment in the
  workspace, grouped by file. Click one to open that file's preview scrolled to it.
- **`⌥↓` / `⌥↑`** — jump to the next/previous comment. Stepping starts from what is
  on screen, not from the last jump.
- **The count button** — a dropdown of every comment in the file; click to jump.
- **The right-edge rail** — one dot per comment at its position in the document.

Whatever you jump to flashes briefly so it is not lost after the scroll.

## Getting comments out

Two buttons in the preview toolbar, because the two jobs are different:
**Copy this file** takes only the comments on the document in front of you,
**Copy all files** takes every comment in the workspace — a whole review pass
across however many files you opened — in one clipboard payload, grouped by file.

| Command | |
|---|---|
| Inline Review: Copy Comments Across All Files | `⌘K ⌘Y` — copies, then focuses the Claude input |
| Inline Review: Copy Comments for Current File | `⌘K ⌘⇧Y` |
| Inline Review: Write Comments to File | writes `CLAUDE-REVIEW.md` to `@`-mention |
| Inline Review: Clear All Comments | |
| Inline Review: Comment on Current Line | `⌘K C` |
| Inline Review: Open Markdown Review Preview | |

The same three live on the **Review Comments** sidebar title bar.

## Reading the document

**Frontmatter is a table.** markdown-it has no frontmatter rule, so a leading
`---` block used to degrade into an `<hr>` plus one bold `<h2>` — the closing
`---` was being read as a setext underline. The block is now consumed and
rendered as a collapsible key/value table, with URLs linked and nested keys
flattened to `parent.child`. Turn it off with `inlineReview.frontmatterAsTable`.

**Code blocks are highlighted properly, in both themes.** Tokens were previously
mapped onto `--vscode-debugTokenExpression-*`, which is tuned for the debug panel
and near-invisible on a light theme. The preview now ships full GitHub Light and
GitHub Dark token sets, selected by the `vscode-light` / `vscode-dark` body class,
on a code surface with its own background and border. Each fence gets a language
label and a copy button (`inlineReview.codeBlockChrome` to hide them). An
unlabelled fence is auto-detected, but only when the guess is confident.

**`⌘F` searches the rendered view.** A find bar with literal, whole-word and
regular-expression modes, case sensitivity, a live match count and `⏎` /
`⇧⏎` to step through hits. Matches are painted with the CSS Custom
Highlight API, so a hit spanning inline markup still highlights and nothing in
the DOM is rewritten underneath the comment cards. `⌘G` steps without
reopening the bar; `Esc` closes.

**Callouts render as callouts.** `> [!note] Title`, in both the GitHub alert
spelling and Obsidian's, becomes a titled, tone-coloured block instead of a
blockquote with a stray `[!note]` sitting in the text. 26 type names across six
tones, an optional custom title, and Obsidian's fold markers: `-` starts
collapsed, `+` starts expanded, neither means not collapsible. An unrecognised
type is left as an ordinary blockquote. Blocks inside a callout keep their real
source line numbers, so you can still comment on them. Turn it off with
`inlineReview.callouts`.

**Mermaid diagrams zoom and pan.** Each rendered diagram sits in its own viewport
rather than being squashed to the text column: drag to pan, `⌘`/`Ctrl` +
wheel to zoom at the pointer, wheel to scroll within the diagram (handing the
wheel back to the page at the edges), `⇧` + wheel to pan sideways,
double-click to fit, and `⤡` to expand to the full window. The same control
becomes `✕` while the overlay is open, so the way out is the way in; there is
also a **Close** button in the corner, `Esc`, and a click on the backdrop. The
overlay takes focus when it opens, so `Esc` lands there rather than wherever you
last clicked. The toolbar carries zoom out / zoom in / the current scale, which resets
to 100% when clicked / fit / expand. Drag the bottom edge of a viewport for a
taller one; `inlineReview.mermaidHeight` is the ceiling, and a diagram that
needs less room is given only what it needs.

The viewport is measured with `getBoundingClientRect()` rather than
`clientWidth`/`clientHeight`, because reading a layout property flushes pending
layout: the earlier version measured the box as it was *before* the diagram was
reparented into the overlay, so expanding left it at the inline scale and Fit
looked broken. A `ResizeObserver` re-fits on any size change — overlay, window
resize, resize grip — unless you have zoomed or panned by hand, in which case
your chosen view is kept.

Output:

````markdown
## docs/guide.md
### L12-L15
```
the commented source lines
```
- your comment
````

The paste into Claude is manual and cannot be automated: its panel is a webview
owned by another extension, and VS Code core registers no webview paste command
(only `workbench.action.webview.openDeveloperTools` and `reloadWebviewAction`).
If you run Claude in a terminal instead, `workbench.action.terminal.sendSequence`
with bracketed-paste markers could inject the text directly — not wired up here.

## Install

```sh
git clone https://github.com/shashank-mugiwara/vscode-inline-review.git
cd vscode-inline-review
npm install --omit=dev
cp -R . ~/.vscode/extensions/local.inline-review-0.1.0
```

Then run **Developer: Reload Window**.

To make it the default for markdown files:

```json
"workbench.editorAssociations": { "*.md": "inlineReview.markdownPreview" }
```

VS Code's own preview and the plain text editor stay available through
**Reopen Editor With…**.

## Settings

| | default | |
|---|---|---|
| `inlineReview.extensions` | `[".md", ".markdown"]` | gutter file types |
| `inlineReview.allFiles` | `false` | gutter on every file |
| `inlineReview.includeSnippet` | `true` | quote source lines in the output |
| `inlineReview.snippetMaxLines` | `8` | |
| `inlineReview.focusClaudeAfterCopy` | `true` | |
| `inlineReview.reviewFileName` | `CLAUDE-REVIEW.md` | |

## Known gaps vs. the built-in preview

- Mermaid works (vendored, client-side). Other markdown extensions that contribute
  `markdownItPlugins` or `previewScripts` — KaTeX, custom containers — do not apply,
  because this is a separate renderer.
- No scroll sync with the source editor. Double-click a block to jump to its source
  line; **Open source** opens the file beside the preview.
- No preview security selector. Remote images load; scripts inside the markdown
  cannot run, since the CSP allows only the nonce-tagged bundle.

## Development

```sh
npm install
npm test     # runs media/preview.js inside jsdom against rendered markdown
```

The suite covers add-button placement and DOM legality, table wrapping, per-list-item
buttons, the click → composer → `add{line,text}` round trip, comment/rail/dropdown
painting, and two CSS specificity regressions that had already shipped once.

Iterate with:

```sh
rsync -a --delete ./ ~/.vscode/extensions/local.inline-review-0.1.0/ \
  --exclude .git --exclude test
```

Webview assets are cache-busted by mtime, so a window reload always picks up edits.

## Third-party

`media/mermaid.min.js` is [Mermaid](https://github.com/mermaid-js/mermaid) 11,
vendored unmodified and MIT licensed. Rendering also uses
[markdown-it](https://github.com/markdown-it/markdown-it) and
[highlight.js](https://github.com/highlightjs/highlight.js), both installed from npm.

## License

MIT — see [LICENSE](LICENSE).
