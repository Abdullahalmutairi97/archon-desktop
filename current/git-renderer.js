// Injected into the verified renderer module. Git changes, history and branch review for the session's repository.
const arGitReviews=new Map();
const arGitReview=root=>{if(!arGitReviews.has(root))arGitReviews.set(root,new ArchonGitModel.Review());return arGitReviews.get(root)};
const arGitNoop={subscribe:()=>()=>{},snapshot:()=>0};
const arGitCall=(op,payload)=>window.archon.api.call(op,payload);
function arGitAge(iso){const s=(Date.now()-Date.parse(iso))/1000;if(!(s>=0))return '';if(s<60)return 'now';if(s<3600)return Math.floor(s/60)+'m';if(s<86400)return Math.floor(s/3600)+'h';if(s<86400*30)return Math.floor(s/86400)+'d';return String(iso).slice(0,10)}
function ArchonGit({visible=true}){
 const {settings,connected,say,confirm,setUi}=Ne();const transcript=arUseTranscript();
 const suggested=transcript.cwd||settings.defaultCwd||'.';
 const [repoInput,setRepoInput]=k.useState(suggested),[repo,setRepo]=k.useState(suggested);
 const [status,setStatus]=k.useState(null),[error,setError]=k.useState(''),[view,setView]=k.useState('changes'),[sel,setSel]=k.useState(null);
 const [diff,setDiff]=k.useState(null),[diffError,setDiffError]=k.useState(''),[diffLoading,setDiffLoading]=k.useState(false);
 const [busy,setBusy]=k.useState(''),[message,setMessage]=k.useState(''),[log,setLog]=k.useState(null),[branches,setBranches]=k.useState(null);
 const [base,setBase]=k.useState(''),[layout,setLayout]=k.useState('unified'),[menu,setMenu]=k.useState(false),[newBranch,setNewBranch]=k.useState('');
 const [tick,setTick]=k.useState(0),[draft,setDraft]=k.useState(null);
 const statusReq=k.useRef(0),diffReq=k.useRef(0);
 const root=status?.root||'';const review=root?arGitReview(root):null;const store=review||arGitNoop;
 k.useSyncExternalStore(store.subscribe,store.snapshot);
 const signature=status?JSON.stringify([status.head,status.branch,status.files]):'';
 k.useEffect(()=>{setRepoInput(suggested);setRepo(suggested);setSel(null)},[suggested]);
 k.useEffect(()=>{if(!visible||!connected)return;const timer=window.setInterval(()=>setTick(t=>t+1),5000);return()=>window.clearInterval(timer)},[visible,connected]);
 k.useEffect(()=>{
  if(!visible)return;if(!connected){setError('Connect to the server to use Git.');return}
  const id=++statusReq.current;
  arGitCall('gitStatus',{path:repo}).then(value=>{if(id===statusReq.current){setStatus(value);setError('')}},e=>{if(id===statusReq.current){setStatus(null);setError(ArchonGitModel.errorText(e))}});
 },[repo,tick,visible,connected]);
 k.useEffect(()=>{
  if(!visible||!root||!sel){setDiff(null);return}
  const id=++diffReq.current;setDiffLoading(true);setDiffError('');
  arGitCall('gitDiff',{path:root,...sel}).then(value=>{if(id===diffReq.current)setDiff(value)},e=>{if(id===diffReq.current){setDiff(null);setDiffError(ArchonGitModel.errorText(e))}}).finally(()=>{if(id===diffReq.current)setDiffLoading(false)});
 },[root,JSON.stringify(sel),sel&&(sel.scope==='unstaged'||sel.scope==='staged')?signature:'',visible]);
 k.useEffect(()=>{if(!visible||!root||view!=='history')return;let live=true;arGitCall('gitLog',{path:root,limit:100}).then(v=>{if(live)setLog(v.commits)},e=>{if(live)say(ArchonGitModel.errorText(e))});return()=>{live=false}},[root,view,status?.head,visible]);
 k.useEffect(()=>{if(!visible||!root||!(menu||view==='compare'))return;let live=true;arGitCall('gitBranches',{path:root}).then(v=>{if(!live)return;setBranches(v);setBase(b=>b||v.default_base||'')},()=>{});return()=>{live=false}},[root,menu,view,status?.branch,visible]);

 const act=async(label,op,payload,after)=>{
  if(busy)return;setBusy(label);
  try{const r=await arGitCall(op,{path:root,...payload});const next=r&&r.files?r:r?.status;if(next)setStatus(next);after?.(r)}
  catch(e){say(ArchonGitModel.errorText(e))}finally{setBusy('')}
 };
 const stage=files=>act('stage','gitStage',{files});
 const unstage=files=>act('unstage','gitUnstage',{files});
 const discard=files=>confirm({title:files.length>1?'Discard '+files.length+' files?':'Discard changes?',body:'Uncommitted edits are lost and new files are deleted. This cannot be undone.',target:files.join('\n'),confirm:'Discard',danger:true,onConfirm:()=>act('discard','gitDiscard',{files,confirm:true},()=>setSel(null))});
 const commit=()=>{if(!message.trim())return;act('commit','gitCommit',{message},r=>{setMessage('');setSel(null);say('Committed '+r.short)})};
 const push=()=>confirm({title:'Push '+(status?.branch||'')+'?',body:status?.upstream?'Send '+status.ahead+' commit(s) to '+status.upstream+'.':'Publish this branch to origin and track it.',target:status?.relative_root||root,confirm:'Push',onConfirm:()=>act('push','gitPush',{confirm:true},()=>say('Pushed'))});
 const switchTo=(branch,create=false)=>act('switch','gitSwitch',{branch,create},()=>{setMenu(false);setNewBranch('');setSel(null);say((create?'Created ':'Switched to ')+branch)});
 const openFile=path=>{void arWorkspace(settings.serverUrl).openFile(root.replace(/\/$/,'')+'/'+path);setUi({bench:'ide'})};
 const sendReview=async()=>{
  const text=review.prompt({label:ArchonGitModel.scopeLabel(sel),root:status.relative_root});
  if(!transcript.sessionId){try{await st.copyText(text);say('No session is open — review copied')}catch{say('Copy failed')}return}
  try{await K.dispatch({prompt:text,sessionId:transcript.sessionId,cwd:transcript.cwd||null,model:settings.model,provider:settings.modelProvider,approval:settings.approval,profile:settings.agentRuntime==='pi'?'pi':null});review.clear();say('Review sent to the agent')}
  catch{say('The server refused the review')}
 };

 const b=(label,action,props={})=>ASn('button',{type:'button',className:'reset-btn ar-git-btn',onClick:action,...props},label);
 const worktree=sel&&(sel.scope==='unstaged'||sel.scope==='staged');
 const g=ArchonGitModel.groups(status?.files);
 const fileRow=(f,staged)=>{
  const active=sel&&worktree&&sel.file===f.path&&(sel.scope==='staged')===staged;
  const slash=f.path.lastIndexOf('/');
  return ASn('div',{key:(staged?'s:':'u:')+f.path,className:'ar-git-row','data-active':!!active},
   ASn('button',{type:'button',className:'reset-btn ar-git-file',title:f.orig_path?f.orig_path+' → '+f.path:f.path,onClick:()=>{setDraft(null);setSel({scope:staged?'staged':'unstaged',file:f.path})}},
    ASn('span',{className:'ar-git-letter','data-letter':ArchonGitModel.letter(f,staged)},ArchonGitModel.letter(f,staged)),
    ASn('span',{className:'ar-git-name'},f.path.slice(slash+1)),slash>0&&ASn('span',{className:'ar-git-dir'},f.path.slice(0,slash))),
   staged?b('−',()=>unstage([f.path]),{title:'Unstage','aria-label':'Unstage '+f.path,disabled:!!busy}):ASn(k.Fragment,null,
    !f.conflicted&&b('↺',()=>discard([f.path]),{title:'Discard changes','aria-label':'Discard '+f.path,disabled:!!busy}),
    b('+',()=>stage([f.path]),{title:f.conflicted?'Mark resolved':'Stage','aria-label':'Stage '+f.path,disabled:!!busy})));
 };
 const section=(title,rows,staged,bulk)=>rows.length?ASn('div',{className:'ar-git-section',key:title},ASn('div',{className:'ar-git-heading'},ASn('span',null,title+' · '+rows.length),bulk),rows.map(f=>fileRow(f,staged))):null;
 const staged=g.staged.length;
 const changes=ASn(k.Fragment,null,
  ASn('div',{className:'ar-git-list'},
   status&&status.clean&&ASn('p',{className:'ar-git-muted'},'No changes. The working tree matches '+(status.branch||'HEAD')+'.'),
   section('Conflicts',g.conflicted,false,null),
   section('Staged',g.staged,true,b('Unstage all',()=>unstage(g.staged.map(f=>f.path)),{disabled:!!busy})),
   section('Changes',[...g.unstaged,...g.untracked],false,ASn('span',null,b('Discard all',()=>discard([...g.unstaged,...g.untracked].map(f=>f.path)),{disabled:!!busy}),b('Stage all',()=>stage([...g.unstaged,...g.untracked].map(f=>f.path)),{disabled:!!busy})))),
  ASn('div',{className:'ar-git-commit'},
   ASn('textarea',{'aria-label':'Commit message',placeholder:'Commit message',value:message,rows:3,onChange:e=>setMessage(e.target.value),onKeyDown:e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();if(staged)commit()}}}),
   b(busy==='commit'?'Committing…':staged?'Commit '+staged+' staged':'Stage files to commit',commit,{className:'reset-btn ar-git-btn ar-git-primary',disabled:!staged||!message.trim()||!!busy})));
 const history=ASn('div',{className:'ar-git-list'},log===null?ASn('p',{className:'ar-git-muted'},'Loading…'):!log.length?ASn('p',{className:'ar-git-muted'},'No commits yet.'):log.map(c=>ASn('button',{key:c.hash,type:'button',className:'reset-btn ar-git-commitrow','data-active':sel?.scope==='commit'&&sel.ref===c.hash,onClick:()=>{setDraft(null);setSel({scope:'commit',ref:c.hash})}},ASn('span',{className:'ar-git-subject'},c.subject),ASn('span',{className:'ar-git-dir'},c.short+' · '+c.author+' · '+arGitAge(c.date)))));
 const compare=ASn('div',{className:'ar-git-list'},
  ASn('form',{className:'ar-git-compare',onSubmit:e=>{e.preventDefault();if(base.trim()){setDraft(null);setSel({scope:'compare',base:base.trim(),ref:'HEAD'})}}},
   ASn('label',null,ASn('span',{className:'ar-git-dir'},'Review '+(status?.branch||'HEAD')+' against'),ASn('input',{list:'ar-git-bases',value:base,onChange:e=>setBase(e.target.value),placeholder:'origin/main','aria-label':'Base branch'})),
   ASn('datalist',{id:'ar-git-bases'},(branches?[...branches.local,...branches.remote]:[]).map(r=>ASn('option',{key:r.name,value:r.name}))),
   b('Compare',null,{type:'submit',className:'reset-btn ar-git-btn ar-git-primary',disabled:!base.trim()})),
  sel?.scope==='compare'&&diff&&ASn('div',null,ASn('div',{className:'ar-git-heading'},ASn('span',null,'Changed files · '+diff.files.length)),diff.files.map(f=>ASn('button',{key:f.path,type:'button',className:'reset-btn ar-git-file',onClick:()=>document.getElementById('ar-git-f-'+encodeURIComponent(f.path))?.scrollIntoView({block:'start'})},ASn('span',{className:'ar-git-letter','data-letter':f.status[0].toUpperCase()},f.status[0].toUpperCase()),ASn('span',{className:'ar-git-name'},f.path)))));

 const comments=(file,line)=>review?review.forLine(file,line).map(c=>ASn('div',{key:c.id,className:'ar-git-comment'},ASn('p',null,c.body),b('Delete',()=>review.remove(c.id),{'aria-label':'Delete comment'}))):[];
 const editor=(file,line)=>draft&&draft.key===ArchonGitModel.lineKey(file,line)?ASn('form',{className:'ar-git-editor',onSubmit:e=>{e.preventDefault();review.add(file,line,draft.text,ArchonGitModel.scopeLabel(sel));setDraft(null)}},
  ASn('textarea',{autoFocus:true,'aria-label':'Review comment',placeholder:'Comment for the agent',value:draft.text,rows:3,onChange:e=>setDraft({...draft,text:e.target.value}),onKeyDown:e=>{if(e.key==='Escape')setDraft(null);if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();e.currentTarget.form.requestSubmit()}}}),
  ASn('div',null,b('Cancel',()=>setDraft(null)),b('Add comment',null,{type:'submit',className:'reset-btn ar-git-btn ar-git-primary',disabled:!draft.text.trim()}))):null;
 const comment=(file,line)=>line&&line.kind!=='meta'&&review?b('+',()=>setDraft({key:ArchonGitModel.lineKey(file,line),text:''}),{className:'reset-btn ar-git-add','aria-label':'Comment on line '+(line.new??line.old),title:'Comment on this line'}):ASn('span',{className:'ar-git-add'});
 const cell=(line,side)=>ASn(k.Fragment,null,ASn('span',{className:'ar-git-no'},line?(side==='old'?line.old:line.new)??'':''),ASn('span',{className:'ar-git-code','data-kind':line?line.kind:'empty'},line?line.text:''));
 const unifiedRows=(file,hunk)=>hunk.lines.flatMap((line,i)=>[
  ASn('div',{key:i,className:'ar-git-line','data-kind':line.kind},comment(file,line),ASn('span',{className:'ar-git-no'},line.old??''),ASn('span',{className:'ar-git-no'},line.new??''),ASn('span',{className:'ar-git-sign'},{add:'+',del:'−',ctx:' ',meta:''}[line.kind]),ASn('span',{className:'ar-git-code'},line.text)),
  ...comments(file,line),editor(file,line)].filter(Boolean));
 const splitRows=(file,hunk)=>ArchonGitModel.sideBySide(hunk.lines).flatMap((row,i)=>{
  if(row.meta)return [ASn('div',{key:i,className:'ar-git-line','data-kind':'meta'},ASn('span',{className:'ar-git-code'},row.meta.text))];
  const target=row.right||row.left;
  return [ASn('div',{key:i,className:'ar-git-split'},comment(file,target),cell(row.left,'old'),cell(row.right,'new')),...comments(file,target),editor(file,target)].filter(Boolean);
 });
 const fileView=f=>ASn('section',{key:f.path,id:'ar-git-f-'+encodeURIComponent(f.path),className:'ar-git-filediff'},
  ASn('header',null,ASn('span',{className:'ar-git-letter','data-letter':f.status[0].toUpperCase()},f.status[0].toUpperCase()),ASn('span',{className:'ar-git-path',title:f.path},f.old_path&&f.old_path!==f.path?f.old_path+' → '+f.path:f.path),ASn('span',{className:'ar-git-stat'},ASn('b',{'data-kind':'add'},'+'+f.additions),' ',ASn('b',{'data-kind':'del'},'−'+f.deletions)),worktree&&f.status!=='deleted'&&b('Open',()=>openFile(f.path),{title:'Open in IDE'})),
  f.hidden?ASn('p',{className:'ar-git-muted'},'Secret-bearing file — content is not shown.'):f.binary?ASn('p',{className:'ar-git-muted'},'Binary file.'):!f.hunks.length?ASn('p',{className:'ar-git-muted'},f.status==='conflicted'?'Conflicted — resolve it in the IDE or terminal, then stage it.':'No text changes (mode or rename only).'):
  ASn('div',{className:'ar-git-hunks'},f.hunks.map((h,i)=>ASn('div',{key:i},ASn('div',{className:'ar-git-hunk'},h.header),...(layout==='split'?splitRows(f.path,h):unifiedRows(f.path,h))))),
  f.truncated&&ASn('p',{className:'ar-git-muted'},'Diff truncated — open the file for the rest.'));
 const count=review?review.items.length:0;
 const viewer=ASn('div',{className:'ar-git-viewer'},
  ASn('div',{className:'ar-git-viewbar'},ASn('span',{className:'ar-git-dir'},sel?ArchonGitModel.scopeLabel(sel)+(sel.file?' · '+sel.file:''):'Select a file or commit'),b('Unified',()=>setLayout('unified'),{'aria-pressed':layout==='unified'}),b('Split',()=>setLayout('split'),{'aria-pressed':layout==='split'})),
  count>0&&ASn('div',{className:'ar-git-review',role:'status'},ASn('span',null,count+' review comment'+(count>1?'s':'')),b('Clear',()=>review.clear()),b('Copy',()=>st.copyText(review.prompt({label:ArchonGitModel.scopeLabel(sel),root:status?.relative_root})).then(()=>say('Review copied'),()=>say('Copy failed'))),b(transcript.sessionId?'Send to agent':'Copy for agent',sendReview,{className:'reset-btn ar-git-btn ar-git-primary'})),
  ASn('div',{className:'ar-git-diff'},!sel?ASn('div',{className:'ar-git-empty'},ASicon('ph-git-diff'),ASn('strong',null,'Review changes'),ASn('p',null,'Pick a changed file, a commit, or compare this branch against its base. Add line comments with +, then send them to the agent.')):
   diffLoading&&!diff?ASn('p',{className:'ar-git-muted'},'Loading diff…'):diffError?ASn('p',{role:'alert',className:'ar-git-muted'},diffError):diff&&!diff.files.length?ASn('p',{className:'ar-git-muted'},'No differences.'):diff?ASn(k.Fragment,null,diff.files.map(fileView),diff.truncated&&ASn('p',{className:'ar-git-muted'},'The diff is very large and was cut short.')):null));

 const localBranches=branches?.local||[];
 return ASn('section',{className:'ar-git','aria-label':'Git'},
  ASn('div',{className:'ar-git-bar'},
   b(ASn(k.Fragment,null,ASicon('ph-git-branch'),' ',status?(status.branch||'detached '+String(status.head||'').slice(0,7)):'—',' ▾'),()=>setMenu(!menu),{'aria-expanded':menu,disabled:!status,title:'Switch branch'}),
   status&&(status.ahead||status.behind)?ASn('span',{className:'ar-git-dir',title:status.upstream||''},'↑'+status.ahead+' ↓'+status.behind):null,
   b(busy==='fetch'?'Fetching…':'Fetch',()=>act('fetch','gitFetch',{}),{disabled:!status||!!busy}),
   b(busy==='push'?'Pushing…':'Push',push,{disabled:!status||!status.branch||!!busy||(!!status.upstream&&!status.ahead)}),
   b('↻',()=>setTick(t=>t+1),{'aria-label':'Refresh','title':'Refresh'}),
   ASn('form',{className:'ar-git-repo',onSubmit:e=>{e.preventDefault();setSel(null);setRepo(repoInput.trim()||'.')}},ASn('input',{'aria-label':'Repository folder',value:repoInput,onChange:e=>setRepoInput(e.target.value),title:status?.root||repoInput}))),
  menu&&ASn('div',{className:'ar-git-menu'},
   localBranches.map(r=>b((r.current?'● ':'')+r.name,()=>switchTo(r.name),{key:r.name,disabled:r.current||!!busy})),
   ASn('form',{onSubmit:e=>{e.preventDefault();if(newBranch.trim())switchTo(newBranch.trim(),true)}},ASn('input',{'aria-label':'New branch name',placeholder:'new-branch-name',value:newBranch,onChange:e=>setNewBranch(e.target.value)}),b('Create',null,{type:'submit',disabled:!newBranch.trim()||!!busy}))),
  error?ASn('div',{className:'ar-git-empty'},ASicon('ph-git-diff'),ASn('strong',null,'Git unavailable here'),ASn('p',{role:'status'},error)):
  ASn(k.Fragment,null,
   ASn('div',{className:'ar-git-tabs',role:'tablist'},[['changes','Changes'+(status?' · '+status.files.length:'')],['history','History'],['compare','Compare']].map(([id,label])=>ASn('button',{key:id,type:'button',role:'tab','aria-selected':view===id,className:'reset-btn ar-git-tab',onClick:()=>{setView(id);setSel(null);setDraft(null)}},label))),
   ASn('div',{className:'ar-git-body'},ASn('aside',{className:'ar-git-side'},view==='changes'?changes:view==='history'?history:compare),viewer)));
}
const ARCHON_GIT_CSS=`
.ar-git{display:flex;flex:1;min-height:0;min-width:0;flex-direction:column;font-size:12px}.ar-git-bar{display:flex;align-items:center;gap:6px;padding:7px 10px;border-bottom:1px solid var(--ar-edge);flex-wrap:wrap}.ar-git-repo{flex:1;min-width:120px;display:flex}.ar-git-repo input,.ar-git-menu input,.ar-git-compare input{flex:1;min-width:0;padding:5px 7px;background:transparent;border:1px solid var(--ar-edge);border-radius:4px;color:inherit;font-size:11px;direction:ltr;text-align:start}.ar-git-btn{cursor:pointer;padding:5px 8px;border-radius:4px;white-space:nowrap;font-size:11px;border:1px solid var(--ar-edge)}.ar-git-btn:hover,.ar-git-btn[aria-pressed=true]{background:var(--ar-hover);color:var(--color-accent)}.ar-git-btn:disabled{opacity:.35;cursor:default}.ar-git-btn:focus-visible,.ar-git-file:focus-visible,.ar-git-tab:focus-visible{outline:1px solid var(--color-accent)}.ar-git-primary{border-color:var(--color-accent);color:var(--color-accent)}.ar-git-menu{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-bottom:1px solid var(--ar-edge);max-height:220px;overflow:auto;background:var(--ar-panel)}.ar-git-menu form{display:flex;gap:6px;margin-top:4px}.ar-git-menu .ar-git-btn{text-align:start}.ar-git-tabs{display:flex;border-bottom:1px solid var(--ar-edge)}.ar-git-tab{padding:8px 12px;cursor:pointer;font-size:11px;opacity:.7}.ar-git-tab[aria-selected=true]{opacity:1;color:var(--color-accent);border-bottom:2px solid var(--color-accent)}.ar-git-body{display:flex;flex:1;min-height:0;min-width:0}.ar-git-side{width:clamp(180px,34%,300px);flex:none;display:flex;flex-direction:column;min-height:0;border-inline-end:1px solid var(--ar-edge);background:var(--ar-panel)}.ar-git-list{flex:1;overflow:auto;min-height:0}.ar-git-heading{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:9px 10px 5px;font-size:10px;letter-spacing:.06em;opacity:.75}.ar-git-heading .ar-git-btn{padding:2px 6px;font-size:10px;border:0}.ar-git-row{display:flex;align-items:center}.ar-git-row[data-active=true],.ar-git-commitrow[data-active=true]{background:var(--ar-hover)}.ar-git-row>.ar-git-btn{border:0;padding:3px 7px;opacity:0}.ar-git-row:hover>.ar-git-btn,.ar-git-row:focus-within>.ar-git-btn{opacity:1}.ar-git-file{display:flex;align-items:baseline;gap:6px;flex:1;min-width:0;padding:5px 10px;cursor:pointer;text-align:start}.ar-git-name{white-space:nowrap}.ar-git-dir{font-size:10px;opacity:.55;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.ar-git-letter{font:600 10px var(--font-mono,monospace);width:12px;flex:none;text-align:center}.ar-git-letter[data-letter=A],.ar-git-letter[data-letter="?"],.ar-git-letter[data-letter=U]{color:#3fb950}.ar-git-letter[data-letter=D]{color:#f85149}.ar-git-letter[data-letter=M],.ar-git-letter[data-letter=R]{color:#d29922}.ar-git-commit{display:flex;flex-direction:column;gap:6px;padding:8px;border-top:1px solid var(--ar-edge)}.ar-git-commit textarea,.ar-git-editor textarea{resize:vertical;min-height:52px;padding:6px;background:transparent;border:1px solid var(--ar-edge);border-radius:4px;color:inherit;font:12px/1.5 inherit}.ar-git-commitrow{display:flex;flex-direction:column;gap:2px;width:100%;padding:7px 10px;cursor:pointer;text-align:start;border-bottom:1px solid var(--ar-edge)}.ar-git-subject{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ar-git-compare{display:flex;flex-direction:column;gap:6px;padding:10px}.ar-git-compare label{display:flex;flex-direction:column;gap:4px}.ar-git-viewer{display:flex;flex:1;min-width:0;min-height:0;flex-direction:column}.ar-git-viewbar{display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid var(--ar-edge)}.ar-git-viewbar>.ar-git-dir{flex:1}.ar-git-diff{flex:1;overflow:auto;min-height:0}.ar-git-filediff{border-bottom:1px solid var(--ar-edge)}.ar-git-filediff header{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--color-surface);border-bottom:1px solid var(--ar-edge)}.ar-git-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:ltr;text-align:start}.ar-git-stat b{font-weight:500;font-size:11px}.ar-git-stat b[data-kind=add]{color:#3fb950}.ar-git-stat b[data-kind=del]{color:#f85149}.ar-git-hunks{direction:ltr;font:12px/19px var(--font-mono,monospace)}.ar-git-hunk{padding:3px 10px;opacity:.6;background:var(--ar-hover)}.ar-git-line,.ar-git-split{display:grid;align-items:start}.ar-git-line{grid-template-columns:18px 42px 42px 14px 1fr}.ar-git-split{grid-template-columns:18px 42px 1fr 42px 1fr}.ar-git-line[data-kind=add],.ar-git-code[data-kind=add]{background:rgba(46,160,67,.16)}.ar-git-line[data-kind=del],.ar-git-code[data-kind=del]{background:rgba(248,81,73,.16)}.ar-git-code[data-kind=empty]{background:var(--ar-hover);opacity:.4;align-self:stretch}.ar-git-line[data-kind=meta]{grid-template-columns:1fr;opacity:.55;padding-inline-start:18px}.ar-git-no{text-align:end;padding-inline-end:6px;opacity:.45;user-select:none}.ar-git-sign{user-select:none;opacity:.7}.ar-git-code{white-space:pre-wrap;overflow-wrap:anywhere;padding-inline-end:10px;min-width:0}.ar-git-add{width:18px;height:19px;display:grid;place-items:center;opacity:0;cursor:pointer;color:var(--color-accent);font-weight:700}.ar-git-line:hover .ar-git-add,.ar-git-split:hover .ar-git-add,.ar-git-add:focus-visible{opacity:1}.ar-git-comment,.ar-git-editor{margin:4px 10px 6px 60px;padding:8px;border:1px solid var(--ar-edge);border-inline-start:3px solid var(--color-accent);border-radius:4px;background:var(--color-surface);font:12px/1.5 inherit;direction:auto}.ar-git-comment{display:flex;gap:8px;align-items:flex-start}.ar-git-comment p{flex:1;margin:0;white-space:pre-wrap}.ar-git-editor{display:flex;flex-direction:column;gap:6px}.ar-git-editor>div{display:flex;gap:6px;justify-content:flex-end}.ar-git-review{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid var(--ar-edge);background:var(--ar-panel)}.ar-git-review>span{flex:1}.ar-git-muted{font-size:11px;opacity:.6;padding:8px 10px;margin:0}.ar-git-empty{margin:auto;padding:28px;text-align:center;max-width:360px;line-height:1.7;opacity:.65}.ar-git-empty strong{display:block;font-size:14px}.ar-git-empty .ph{font-size:22px}
`;
