class Uri { constructor(p){this.fsPath=p;} static file(p){return new Uri(p);} static joinPath(u,...r){return new Uri([u.fsPath,...r].join('/'));} static parse(s){return new Uri(s.replace('file://',''));} toString(){return 'file://'+this.fsPath;} with(o){const u=new Uri(this.fsPath);u.q=o.query;return u;} }
class EventEmitter { constructor(){this._h=[];} get event(){return (fn)=>{this._h.push(fn);return {dispose:()=>{}};};} fire(v){this._h.forEach(f=>f(v));} dispose(){} }
class TreeItem { constructor(l,s){this.label=l;this.collapsibleState=s;} }
class ThemeIcon { constructor(i){this.id=i;} } ThemeIcon.File='file';
class MarkdownString { constructor(v){this.value=v;} }
class Range { constructor(a,b,c,d){this.start={line:a,character:b};this.end={line:c,character:d};} }
module.exports={Uri,EventEmitter,TreeItem,ThemeIcon,MarkdownString,Range,
 TreeItemCollapsibleState:{None:0,Collapsed:1,Expanded:2},CommentMode:{Preview:0,Editing:1},
 CommentThreadCollapsibleState:{Collapsed:0,Expanded:1},window:{},workspace:{getConfiguration:()=>({get:(k,d)=>d})},
 comments:{},commands:{},env:{},ViewColumn:{},TextEditorRevealType:{},Position:class{},Selection:class{}};
