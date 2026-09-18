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

| Command | |
|---|---|
| Inline Review: Copy All Comments | `⌘K ⌘Y` — copies, then focuses the Claude input |
| Inline Review: Copy Comments for Current File | |
| Inline Review: Write Comments to File | writes `CLAUDE-REVIEW.md` to `@`-mention |
| Inline Review: Clear All Comments | |
| Inline Review: Comment on Current Line | `⌘K C` |
| Inline Review: Open Markdown Review Preview | |

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
