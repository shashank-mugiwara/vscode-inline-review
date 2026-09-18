const vscode = require('vscode');
const path = require('path');

/**
 * Sidebar index of every review comment, grouped by file.
 * Selecting a leaf opens that file's review preview scrolled to the comment.
 */
class CommentsTree {
  /**
   * @param {{all:Function, onChange:vscode.Event}} store
   * @param {{reveal:Function}} preview
   */
  constructor(store, preview) {
    this.store = store;
    this.preview = preview;
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
    this._sub = store.onChange(() => this._emitter.fire());
  }

  dispose() {
    this._sub.dispose();
    this._emitter.dispose();
  }

  getTreeItem(node) {
    if (node.kind === 'file') {
      const item = new vscode.TreeItem(
        path.basename(node.uri.fsPath),
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.resourceUri = node.uri;
      item.description = `${node.children.length}`;
      item.iconPath = vscode.ThemeIcon.File;
      item.contextValue = 'inlineReviewFile';
      return item;
    }

    const first = node.comment.body.split('\n').find((l) => l.trim()) || node.comment.body;
    const item = new vscode.TreeItem(first.trim(), vscode.TreeItemCollapsibleState.None);
    item.description = `L${node.comment.line + 1}`;
    item.tooltip = new vscode.MarkdownString(node.comment.body);
    item.iconPath = new vscode.ThemeIcon('comment');
    item.contextValue = 'inlineReviewComment';
    item.command = {
      command: 'inlineReview.revealComment',
      title: 'Go to comment',
      arguments: [node.uri, node.comment.id, node.comment.line],
    };
    return item;
  }

  getChildren(node) {
    if (!node) {
      const groups = new Map();
      for (const { uri, comment } of this.store.all()) {
        const key = uri.toString();
        if (!groups.has(key)) groups.set(key, { kind: 'file', uri, children: [] });
        groups.get(key).children.push({ kind: 'comment', uri, comment });
      }
      return [...groups.values()].sort((a, b) => a.uri.fsPath.localeCompare(b.uri.fsPath));
    }
    if (node.kind === 'file') {
      return node.children.sort((a, b) => a.comment.line - b.comment.line);
    }
    return [];
  }
}

module.exports = { CommentsTree };
