const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

const VIEW_TYPE = 'inlineReview.markdownPreview';

function nonce() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Languages highlightAuto may pick from for an unlabelled fence. */
const AUTO_LANGS = [
  'javascript', 'typescript', 'python', 'java', 'go', 'rust', 'bash', 'shell',
  'json', 'yaml', 'sql', 'xml', 'css', 'dockerfile', 'ini',
];

/** markdown-it configured to stamp every block with its source line. */
function createRenderer() {
  const hljs = require('highlight.js');
  const md = require('markdown-it')({
    html: true,
    linkify: true,
    breaks: false,
    highlight(code, lang) {
      const name = (lang || '').trim().split(/[\s:{,]/)[0].toLowerCase();
      if (name && hljs.getLanguage(name)) {
        try {
          return hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
        } catch (_) { /* fall through to auto-detect */ }
      }
      // An unlabelled fence still deserves colour — guess, but only from the
      // common languages, so prose fences are not painted as code.
      if (!name) {
        try {
          const auto = hljs.highlightAuto(code, AUTO_LANGS);
          if (auto.relevance >= 8) return auto.value;
        } catch (_) { /* fall through */ }
      }
      return md.utils.escapeHtml(code);
    },
  });

  require('./frontmatter').install(md, () =>
    vscode.workspace.getConfiguration('inlineReview').get('frontmatterAsTable', true) !== false);
  require('./callouts').install(md, () =>
    vscode.workspace.getConfiguration('inlineReview').get('callouts', true) !== false);

  // Only tags a comment <div> may legally follow (or sit inside). Table internals are
  // excluded: a div after a <tr> gets hoisted out of the table by the parser.
  const ANCHORABLE = new Set([
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'ul', 'ol', 'li', 'blockquote', 'table', 'hr', 'dl', 'dd',
  ]);

  // Block-level tokens carry token.map = [startLine, endLine].
  const renderToken = md.renderer.renderToken.bind(md.renderer);
  md.renderer.renderToken = (tokens, idx, options) => {
    const t = tokens[idx];
    if (t.map && t.nesting !== -1 && t.block && ANCHORABLE.has(t.tag)) {
      t.attrSet('data-line', String(t.map[0]));
      t.attrJoin('class', 'ir-block');
    }
    return renderToken(tokens, idx, options);
  };

  // fence / code_block / html_block bypass renderToken, so wrap them.
  for (const rule of ['fence', 'code_block', 'html_block']) {
    const orig = md.renderer.rules[rule];
    md.renderer.rules[rule] = (tokens, idx, opts, env, self) => {
      const t = tokens[idx];
      const line = t.map ? t.map[0] : 0;

      // Mermaid fences are handed to the client bundle as raw source.
      if (rule === 'fence') {
        const info = (t.info || '').trim().split(/\s+/)[0].toLowerCase();
        if (info === 'mermaid') {
          return `<div class="ir-block" data-line="${line}">`
            + `<pre class="ir-mermaid">${md.utils.escapeHtml(t.content)}</pre></div>`;
        }
      }

      const inner = orig
        ? orig(tokens, idx, opts, env, self)
        : md.renderer.renderToken(tokens, idx, opts);
      // html_block is not code and must not get code chrome.
      if (rule === 'html_block') return `<div class="ir-block" data-line="${line}">${inner}</div>`;
      const lang = rule === 'fence' ? (t.info || '').trim().split(/\s+/)[0].toLowerCase() : '';
      return `<div class="ir-block ir-code" data-lang="${md.utils.escapeHtml(lang)}"`
        + ` data-line="${line}">${inner}</div>`;
    };
  }

  return md;
}

class MarkdownReviewPreview {
  /**
   * @param {vscode.ExtensionContext} context
   * @param {{listFor:Function, add:Function, edit:Function, remove:Function, onChange:vscode.Event}} store
   */
  constructor(context, store) {
    this.context = context;
    this.store = store;
    this.md = createRenderer();
    /** @type {Map<string, Set<vscode.WebviewPanel>>} */
    this.panels = new Map();
  }

  /** Bring a comment into view, opening the preview first if it is not already up. */
  async reveal(uri, id, line) {
    const key = uri.toString();
    if (!this.panels.has(key) || this.panels.get(key).size === 0) {
      await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
      // resolveCustomTextEditor lands asynchronously; wait briefly for it.
      for (let i = 0; i < 40 && !(this.panels.get(key) || { size: 0 }).size; i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    const set = this.panels.get(key);
    if (!set || set.size === 0) return;
    const panel = [...set][set.size - 1];
    panel.reveal(panel.viewColumn, false);
    panel.webview.postMessage({ type: 'reveal', id, line });
  }

  register() {
    return vscode.window.registerCustomEditorProvider(VIEW_TYPE, this, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    });
  }

  resolveCustomTextEditor(document, panel, _token) {
    const webview = panel.webview;
    const docDir = vscode.Uri.file(path.dirname(document.uri.fsPath));
    const roots = [this.context.extensionUri, docDir];
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (folder) roots.push(folder.uri);

    webview.options = { enableScripts: true, localResourceRoots: roots };
    webview.html = this.shell(webview);

    const key = document.uri.toString();
    if (!this.panels.has(key)) this.panels.set(key, new Set());
    this.panels.get(key).add(panel);

    const settings = () => {
      const c = vscode.workspace.getConfiguration('inlineReview');
      return {
        codeBlockChrome: c.get('codeBlockChrome', true) !== false,
        mermaidHeight: Number(c.get('mermaidHeight', 520)) || 520,
      };
    };

    const pushContent = () => {
      webview.postMessage({
        type: 'update',
        html: this.renderBody(document, webview, docDir),
        comments: this.store.listFor(document.uri),
        settings: settings(),
      });
    };
    const pushComments = () => {
      webview.postMessage({ type: 'comments', comments: this.store.listFor(document.uri) });
    };

    const subs = [];
    subs.push(vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString()) pushContent();
    }));
    subs.push(this.store.onChange(() => pushComments()));
    subs.push(vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('inlineReview')) pushContent();
    }));

    subs.push(webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          pushContent();
          break;
        case 'add':
          this.store.add(document.uri, msg.line, msg.endLine ?? msg.line, msg.text);
          break;
        case 'edit':
          this.store.edit(msg.id, msg.text);
          break;
        case 'delete':
          this.store.remove(msg.id);
          break;
        case 'openSource': {
          const ed = await vscode.window.showTextDocument(document, {
            viewColumn: vscode.ViewColumn.Beside,
            preview: false,
          });
          const pos = new vscode.Position(msg.line || 0, 0);
          ed.selection = new vscode.Selection(pos, pos);
          ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
          break;
        }
        case 'openLink':
          await this.openLink(msg.href, document);
          break;
        case 'copyAll':
          await vscode.commands.executeCommand('inlineReview.copyAll');
          break;
        case 'copyFile':
          await vscode.commands.executeCommand('inlineReview.copyFileComments', document.uri);
          break;
        case 'copyCode':
          await vscode.env.clipboard.writeText(String(msg.text || ''));
          vscode.window.setStatusBarMessage('$(clippy) Code block copied', 2000);
          break;
      }
    }));

    panel.onDidDispose(() => {
      subs.forEach((d) => d.dispose());
      const set = this.panels.get(key);
      if (set) {
        set.delete(panel);
        if (set.size === 0) this.panels.delete(key);
      }
    });
  }

  async openLink(href, document) {
    if (!href) return;
    if (/^(https?|mailto):/i.test(href)) {
      await vscode.env.openExternal(vscode.Uri.parse(href));
      return;
    }
    const [rel, frag] = href.split('#');
    if (!rel) return; // pure anchor, handled in the webview
    const target = vscode.Uri.file(path.resolve(path.dirname(document.uri.fsPath), rel));
    try {
      await vscode.commands.executeCommand('vscode.open', target);
    } catch (_) {
      vscode.window.showWarningMessage(`Inline Review: cannot open ${rel}${frag ? '#' + frag : ''}`);
    }
  }

  renderBody(document, webview, docDir) {
    const html = this.md.render(document.getText());
    // Rewrite relative image sources to webview URIs.
    return html.replace(/(<img\b[^>]*\bsrc=")([^"]+)(")/gi, (m, pre, src, post) => {
      if (/^(https?:|data:|vscode-)/i.test(src)) return m;
      try {
        const abs = vscode.Uri.file(path.resolve(docDir.fsPath, decodeURIComponent(src)));
        return pre + webview.asWebviewUri(abs).toString() + post;
      } catch (_) {
        return m;
      }
    });
  }

  shell(webview) {
    const n = nonce();
    // Webview resources are cached by URL, so stamp each with its mtime. Without this
    // an edited stylesheet or script keeps serving the previous build after a reload.
    const uri = (...p) => {
      const file = vscode.Uri.joinPath(this.context.extensionUri, ...p);
      let v = '0';
      try {
        v = String(Math.floor(fs.statSync(file.fsPath).mtimeMs));
      } catch (_) { /* fall back to an unversioned URL */ }
      return webview.asWebviewUri(file).with({ query: `v=${v}` }).toString();
    };
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}'; font-src ${webview.cspSource};" />
<link rel="stylesheet" href="${uri('media', 'preview.css')}" />
</head>
<body>
<div id="toolbar">
  <button id="btn-copy-file" title="Copy the review comments on this file">Copy this file</button>
  <button id="btn-copy" title="Copy review comments from every file you have commented on">Copy all files</button>
  <button id="btn-source" title="Open the markdown source beside this">Open source</button>
  <button id="btn-find" title="Find in this document (⌘F)">Find</button>
  <span id="nav">
    <button id="btn-prev" title="Previous comment (⌥↑)">↑</button>
    <button id="btn-next" title="Next comment (⌥↓)">↓</button>
    <button id="btn-list" title="List all comments in this file">0 comments</button>
  </span>
</div>
<div id="find" hidden>
  <input id="find-input" type="text" placeholder="Find" spellcheck="false" aria-label="Find" />
  <button id="find-case" class="toggle" title="Match case">Aa</button>
  <button id="find-word" class="toggle" title="Match whole word">ab</button>
  <button id="find-regex" class="toggle" title="Use regular expression">.*</button>
  <span id="find-count">No results</span>
  <button id="find-prev" title="Previous match (⇧⏎)">↑</button>
  <button id="find-next" title="Next match (⏎)">↓</button>
  <button id="find-close" title="Close (Esc)">✕</button>
</div>
<div id="list" hidden></div>
<div id="zoom" hidden tabindex="-1">
  <button id="zoom-close" title="Exit full window (Esc)">✕ Close</button>
  <div id="zoom-stage"></div>
</div>
<div id="rail"></div>
<div id="content"></div>
<script nonce="${n}" src="${uri('media', 'mermaid.min.js')}"></script>
<script nonce="${n}" src="${uri('media', 'preview.js')}"></script>
</body>
</html>`;
  }
}

module.exports = { MarkdownReviewPreview, VIEW_TYPE };
