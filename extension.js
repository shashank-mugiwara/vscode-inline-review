const vscode = require('vscode');
const path = require('path');

const STATE_KEY = 'inlineReview.threads.v1';

/** @type {vscode.CommentController} */
let controller;
/** @type {Set<vscode.CommentThread>} */
const threads = new Set();
/** @type {vscode.ExtensionContext} */
let ctx;
let nextId = 1;
const changeEmitter = new vscode.EventEmitter();

function cfg() {
  return vscode.workspace.getConfiguration('inlineReview');
}

/**
 * A diff editor's left pane uses the `git:` scheme, whose real path lives in the
 * query blob. Normalise so both panes of a diff report the same file.
 */
function realPath(uri) {
  if (uri.scheme === 'git' || uri.scheme === 'gitlens') {
    try {
      const q = JSON.parse(uri.query);
      if (q && q.path) return q.path;
    } catch (_) { /* fall through to fsPath */ }
  }
  return uri.fsPath;
}

function displayPath(uri) {
  const p = realPath(uri);
  const folder = (vscode.workspace.workspaceFolders || [])[0];
  if (folder && p.startsWith(folder.uri.fsPath + path.sep)) {
    return path.relative(folder.uri.fsPath, p);
  }
  return p;
}

function isEnabled(document) {
  if (document.uri.scheme === 'output' || document.uri.scheme === 'vscode') return false;
  if (cfg().get('allFiles')) return true;
  const exts = cfg().get('extensions') || [];
  const lower = document.uri.path.toLowerCase();
  return exts.some((e) => lower.endsWith(String(e).toLowerCase()));
}

// ---------------------------------------------------------------- comments

function makeComment(body, thread) {
  return {
    id: nextId++,
    body: new vscode.MarkdownString(body),
    rawBody: body,
    mode: vscode.CommentMode.Preview,
    author: { name: 'Review' },
    contextValue: 'canEdit',
    thread,
  };
}

function labelFor(thread) {
  const s = thread.range.start.line + 1;
  const e = thread.range.end.line + 1;
  return s === e ? `Line ${s}` : `Lines ${s}–${e}`;
}

function addComment(reply, isReply) {
  const text = (reply.text || '').trim();
  if (!text) return;
  const thread = reply.thread;
  thread.comments = [...thread.comments, makeComment(text, thread)];
  thread.label = labelFor(thread);
  thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  thread.contextValue = 'inlineReview';
  threads.add(thread);
  persist();
}

function disposeThread(thread) {
  threads.delete(thread);
  thread.dispose();
  persist();
}

// ---------------------------------------------------------------- collect

function collect(filterUri) {
  const byFile = new Map();
  for (const thread of threads) {
    if (!thread.comments || thread.comments.length === 0) continue;
    if (filterUri && realPath(thread.uri) !== realPath(filterUri)) continue;
    const key = displayPath(thread.uri);
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key).push(thread);
  }
  for (const list of byFile.values()) {
    list.sort((a, b) => a.range.start.line - b.range.start.line);
  }
  return byFile;
}

async function snippetFor(thread) {
  if (!cfg().get('includeSnippet')) return null;
  const max = cfg().get('snippetMaxLines') || 8;
  let doc;
  try {
    doc = await vscode.workspace.openTextDocument(thread.uri);
  } catch (_) {
    return null;
  }
  const start = thread.range.start.line;
  const end = Math.min(thread.range.end.line, start + max - 1);
  const lines = [];
  for (let i = start; i <= end && i < doc.lineCount; i++) {
    lines.push(doc.lineAt(i).text);
  }
  if (thread.range.end.line > end) lines.push('…');
  return lines.join('\n');
}

async function render(byFile) {
  if (byFile.size === 0) return null;
  const out = ['# Review comments', ''];
  let count = 0;
  for (const [file, list] of byFile) {
    out.push(`## ${file}`, '');
    for (const thread of list) {
      const s = thread.range.start.line + 1;
      const e = thread.range.end.line + 1;
      out.push(s === e ? `### L${s}` : `### L${s}-L${e}`);
      const snip = await snippetFor(thread);
      if (snip !== null && snip.trim() !== '') {
        out.push('', '```', snip, '```');
      }
      out.push('');
      for (const c of thread.comments) {
        out.push(...String(c.rawBody ?? c.body?.value ?? '').split('\n').map((l) => `- ${l}`.replace(/^- $/, '-')));
        count++;
      }
      out.push('');
    }
  }
  return { text: out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n', count, files: byFile.size };
}

async function copy(byFile, what) {
  const result = await render(byFile);
  if (!result) {
    vscode.window.showInformationMessage(`Inline Review: no comments ${what}.`);
    return;
  }
  await vscode.env.clipboard.writeText(result.text);
  vscode.window.setStatusBarMessage(
    `$(clippy) Copied ${result.count} comment${result.count === 1 ? '' : 's'} from ${result.files} file${result.files === 1 ? '' : 's'}`,
    4000,
  );
  if (cfg().get('focusClaudeAfterCopy')) {
    for (const id of ['claude-vscode.focus', 'claude-code.focus']) {
      try {
        await vscode.commands.executeCommand(id);
        break;
      } catch (_) { /* extension not installed; clipboard still holds it */ }
    }
  }
}

// ---------------------------------------------------------------- persistence

function persist() {
  const data = [];
  for (const t of threads) {
    if (!t.comments || t.comments.length === 0) continue;
    data.push({
      uri: t.uri.toString(),
      start: t.range.start.line,
      end: t.range.end.line,
      comments: t.comments.map((c) => String(c.rawBody ?? c.body?.value ?? '')),
    });
  }
  ctx.workspaceState.update(STATE_KEY, data);
  changeEmitter.fire();
}

/** Flat, serialisable view of the threads — what the preview webview talks to. */
const store = {
  onChange: changeEmitter.event,

  listFor(uri) {
    const target = realPath(uri);
    const out = [];
    for (const t of threads) {
      if (realPath(t.uri) !== target) continue;
      for (const c of t.comments || []) {
        out.push({
          id: c.id,
          line: t.range.start.line,
          endLine: t.range.end.line,
          body: String(c.rawBody ?? c.body?.value ?? ''),
        });
      }
    }
    return out.sort((a, b) => a.line - b.line || a.id - b.id);
  },

  /** Every comment in the workspace, for the sidebar index. */
  all() {
    const out = [];
    for (const t of threads) {
      for (const c of t.comments || []) {
        out.push({
          uri: t.uri,
          comment: {
            id: c.id,
            line: t.range.start.line,
            body: String(c.rawBody ?? c.body?.value ?? ''),
          },
        });
      }
    }
    return out;
  },

  add(uri, startLine, endLine, text) {
    const body = String(text || '').trim();
    if (!body) return;
    const range = new vscode.Range(startLine, 0, Math.max(endLine, startLine), 0);
    const thread = controller.createCommentThread(uri, range, []);
    thread.comments = [makeComment(body, thread)];
    thread.label = labelFor(thread);
    thread.contextValue = 'inlineReview';
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    threads.add(thread);
    persist();
  },

  edit(id, text) {
    const body = String(text || '').trim();
    if (!body) return;
    for (const t of threads) {
      if (!(t.comments || []).some((c) => c.id === id)) continue;
      t.comments = t.comments.map((c) =>
        c.id === id
          ? { ...c, rawBody: body, body: new vscode.MarkdownString(body), mode: vscode.CommentMode.Preview }
          : c);
      persist();
      return;
    }
  },

  remove(id) {
    for (const t of [...threads]) {
      if (!(t.comments || []).some((c) => c.id === id)) continue;
      t.comments = t.comments.filter((c) => c.id !== id);
      if (t.comments.length === 0) disposeThread(t);
      else persist();
      return;
    }
  },
};

function restore() {
  const data = ctx.workspaceState.get(STATE_KEY) || [];
  for (const d of data) {
    try {
      const uri = vscode.Uri.parse(d.uri);
      const range = new vscode.Range(d.start, 0, d.end, 0);
      const thread = controller.createCommentThread(uri, range, []);
      thread.comments = d.comments.map((b) => makeComment(b, thread));
      thread.label = labelFor(thread);
      thread.contextValue = 'inlineReview';
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
      threads.add(thread);
    } catch (_) { /* skip unrestorable thread */ }
  }
}

// ---------------------------------------------------------------- activate

function activate(context) {
  ctx = context;
  controller = vscode.comments.createCommentController('inlineReview', 'Inline Review');
  controller.options = {
    prompt: 'Leave a review comment for Claude…',
    placeHolder: 'What should change here?',
  };
  controller.commentingRangeProvider = {
    provideCommentingRanges(document) {
      if (!isEnabled(document)) return [];
      return [new vscode.Range(0, 0, Math.max(document.lineCount - 1, 0), 0)];
    },
  };
  context.subscriptions.push(controller);

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('inlineReview.createComment', (reply) => addComment(reply, false));
  reg('inlineReview.replyComment', (reply) => addComment(reply, true));

  reg('inlineReview.editComment', (comment) => {
    const thread = comment.thread;
    if (!thread) return;
    thread.comments = thread.comments.map((c) =>
      c.id === comment.id ? { ...c, mode: vscode.CommentMode.Editing } : c);
  });

  reg('inlineReview.saveEdit', (comment) => {
    const thread = comment.thread;
    if (!thread) return;
    thread.comments = thread.comments.map((c) => {
      if (c.id !== comment.id) return c;
      const body = String(comment.body?.value ?? comment.body ?? '');
      return { ...c, rawBody: body, body: new vscode.MarkdownString(body), mode: vscode.CommentMode.Preview };
    });
    persist();
  });

  reg('inlineReview.cancelEdit', (comment) => {
    const thread = comment.thread;
    if (!thread) return;
    thread.comments = thread.comments.map((c) =>
      c.id === comment.id
        ? { ...c, body: new vscode.MarkdownString(c.rawBody ?? ''), mode: vscode.CommentMode.Preview }
        : c);
  });

  reg('inlineReview.deleteComment', (comment) => {
    const thread = comment.thread;
    if (!thread) return;
    thread.comments = thread.comments.filter((c) => c.id !== comment.id);
    if (thread.comments.length === 0) disposeThread(thread);
    else persist();
  });

  reg('inlineReview.deleteThread', (thread) => disposeThread(thread));

  reg('inlineReview.commentAtCursor', async () => {
    let ed = vscode.window.activeTextEditor;
    // If the markdown preview is focused, jump to the matching source line first.
    if (!ed) {
      try {
        await vscode.commands.executeCommand('markdown.showSource');
        ed = vscode.window.activeTextEditor;
      } catch (_) { /* not a preview */ }
    }
    if (!ed) {
      vscode.window.showInformationMessage('Inline Review: no source editor to comment on.');
      return;
    }
    if (!isEnabled(ed.document)) {
      vscode.window.showInformationMessage('Inline Review: commenting is not enabled for this file type.');
      return;
    }
    const sel = ed.selection;
    const range = new vscode.Range(sel.start.line, 0, sel.end.line, 0);
    const thread = controller.createCommentThread(ed.document.uri, range, []);
    thread.label = labelFor(thread);
    thread.contextValue = 'inlineReview';
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    threads.add(thread);
  });

  reg('inlineReview.copyAll', () => copy(collect(null), 'to copy'));

  // Called by the preview toolbar, which knows its own document but is not an
  // active text editor, so `copyCurrentFile` cannot see it.
  reg('inlineReview.copyFileComments', (uri) => {
    if (!uri) return;
    return copy(collect(uri), 'on this file');
  });

  reg('inlineReview.copyCurrentFile', () => {
    const ed = vscode.window.activeTextEditor;
    const input = vscode.window.tabGroups?.activeTabGroup?.activeTab?.input;
    const uri = ed ? ed.document.uri : (input && input.uri);
    if (!uri) {
      vscode.window.showInformationMessage('Inline Review: no active editor.');
      return;
    }
    return copy(collect(uri), 'on this file');
  });

  reg('inlineReview.writeToFile', async () => {
    const result = await render(collect(null));
    if (!result) {
      vscode.window.showInformationMessage('Inline Review: no comments to write.');
      return;
    }
    const folder = (vscode.workspace.workspaceFolders || [])[0];
    if (!folder) {
      vscode.window.showWarningMessage('Inline Review: no workspace folder open.');
      return;
    }
    const name = cfg().get('reviewFileName') || 'CLAUDE-REVIEW.md';
    const target = vscode.Uri.joinPath(folder.uri, name);
    await vscode.workspace.fs.writeFile(target, Buffer.from(result.text, 'utf8'));
    const pick = await vscode.window.showInformationMessage(
      `Inline Review: wrote ${result.count} comment${result.count === 1 ? '' : 's'} to ${name}`,
      'Open',
    );
    if (pick === 'Open') await vscode.window.showTextDocument(target);
  });

  reg('inlineReview.clearAll', async () => {
    if (threads.size === 0) return;
    const pick = await vscode.window.showWarningMessage(
      `Delete all ${threads.size} review thread${threads.size === 1 ? '' : 's'}?`,
      { modal: true },
      'Delete',
    );
    if (pick !== 'Delete') return;
    for (const t of [...threads]) t.dispose();
    threads.clear();
    persist();
  });

  reg('inlineReview.openPreview', async () => {
    const ed = vscode.window.activeTextEditor;
    const uri = ed ? ed.document.uri : vscode.window.tabGroups.activeTabGroup?.activeTab?.input?.uri;
    if (!uri) {
      vscode.window.showInformationMessage('Inline Review: no file to preview.');
      return;
    }
    await vscode.commands.executeCommand('vscode.openWith', uri, 'inlineReview.markdownPreview');
  });

  restore();

  const { MarkdownReviewPreview } = require('./preview');
  const preview = new MarkdownReviewPreview(context, store);
  context.subscriptions.push(preview.register());

  const { CommentsTree } = require('./tree');
  const tree = new CommentsTree(store, preview);
  context.subscriptions.push(tree);
  context.subscriptions.push(
    vscode.window.createTreeView('inlineReview.comments', { treeDataProvider: tree }),
  );

  reg('inlineReview.revealComment', (uri, id, line) => preview.reveal(uri, id, line));
}

function deactivate() {
  for (const t of threads) t.dispose();
  threads.clear();
}

module.exports = { activate, deactivate, __test: { store, threads } };
