const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const Model=require('../git-model.cjs');

test('errors read as what Git or the server said',()=>{
 assert.equal(Model.errorText(Error("Error invoking remote method 'api:call': Error: POST /api/git/commit → 409: lint failed: fix app.py")),'lint failed: fix app.py');
 assert.equal(Model.errorText(Error('GET /api/git/status → 404')),'Not a Git repository.');
 assert.equal(Model.errorText(Error('unauthorized: the device token was rejected')),'The server rejected this device token.');
 assert.equal(Model.errorText(Error('fetch failed')),'fetch failed');
});

test('files group into conflicts, staged, unstaged and untracked',()=>{
 const g=Model.groups([{path:'a',staged:true,unstaged:true,index:'M',worktree:'M'},{path:'b',untracked:true,unstaged:true},{path:'c',conflicted:true},{path:'d',staged:true,index:'A',worktree:'.'}]);
 assert.deepEqual(Object.fromEntries(Object.entries(g).map(([k,v])=>[k,v.map(f=>f.path)])),{conflicted:['c'],staged:['a','d'],unstaged:['a'],untracked:['b']});
 assert.equal(Model.letter({index:'A',worktree:'.'},true),'A');
 assert.equal(Model.letter({untracked:true},false),'?');
});

test('side-by-side pairs each removed line with its replacement',()=>{
 const l=(kind,text,old,nw)=>({kind,text,old,new:nw});
 const rows=Model.sideBySide([l('ctx','a',1,1),l('del','b',2,null),l('del','c',3,null),l('add','B',null,2),l('ctx','d',4,3),l('add','e',null,4),l('meta','\\ No newline',null,null)]);
 assert.deepEqual(rows.map(r=>r.meta?['meta']:[r.left?.text??null,r.right?.text??null]),[['a','a'],['b','B'],['c',null],['d','d'],[null,'e'],['meta']]);
});

test('review comments build one message the agent can act on',()=>{
 const review=new Model.Review();let changes=0;review.subscribe(()=>changes++);
 assert.equal(review.add('src/app.ts',{kind:'add',text:'  const x = 1;',new:12,old:null},'   '),null);
 const first=review.add('src/app.ts',{kind:'add',text:'  const x = 1;',new:12,old:null},'Name this better\nand add a test');
 review.add('README.md',{kind:'del',text:'old line',old:3,new:null},'Why was this removed?');
 assert.equal(review.forLine('src/app.ts',{new:12}).length,1);
 const text=review.prompt({label:'working-tree changes',root:'projects/app'});
 assert.match(text,/^Code review of working-tree changes in projects\/app\. Please address each comment/);
 assert.match(text,/1\. src\/app\.ts:12\n   > const x = 1;\n   Name this better\n   and add a test/);
 assert.match(text,/2\. README\.md:3 \(removed line\)\n   > old line\n   Why was this removed\?/);
 review.remove(first.id);review.clear();assert.equal(review.items.length,0);assert.equal(changes,4);
});

function harness({calls={},session='s1'}={}){
 let cursor=0,slots=[],pending=[];const seen=[],said=[],confirms=[],dispatched=[],copied=[],opened=[];
 const ctx={ui:{bench:'git'},settings:{serverUrl:'server-a',defaultCwd:'/home/archon',model:'m',modelProvider:'p',approval:'ask',agentRuntime:'prime'},connected:true,say:m=>said.push(m),confirm:c=>confirms.push(c),setUi(){}};
 const useState=initial=>{const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return [slots[i],v=>{slots[i]=typeof v==='function'?v(slots[i]):v}]};
 const k={Fragment:'fragment',useState,useRef:v=>useState(()=>({current:v}))[0],useMemo:fn=>fn(),useSyncExternalStore:(_,snapshot)=>snapshot(),useEffect(fn,deps){const i=cursor++,old=slots[i];if(!old||!deps||deps.some((d,n)=>d!==old.deps[n])){pending.push(()=>{old?.cleanup?.();slots[i]={deps,cleanup:fn()}})}}};
 const defaults={
  gitStatus:()=>({root:'/srv/app',relative_root:'app',branch:'main',head:'abc',upstream:'origin/main',ahead:1,behind:0,clean:false,files:[{path:'src/a.ts',index:'.',worktree:'M',staged:false,unstaged:true},{path:'b.txt',index:'A',worktree:'.',staged:true,unstaged:false},{path:'.env',index:'.',worktree:'M',staged:false,unstaged:true,secret:true}]}),
  gitDiff:p=>({root:'/srv/app',scope:p.scope,files:[{path:p.file||'src/a.ts',old_path:p.file||'src/a.ts',status:'modified',additions:1,deletions:1,binary:false,hidden:p.file==='.env',truncated:false,hunks:p.file==='.env'?[]:[{header:'@@ -1 +1 @@',lines:[{kind:'del',text:'old',old:1,new:null},{kind:'add',text:'new',old:null,new:1}]}]}]}),
  gitStage:()=>defaults.gitStatus(),gitCommit:()=>({short:'def456',status:{...defaults.gitStatus(),files:[]}}),
 };
 const window={archon:{api:{call:async(op,payload)=>{seen.push({op,payload});const fn=calls[op]||defaults[op];if(!fn)return {};return fn(payload)}}},setInterval:()=>1,clearInterval(){}};
 const context=vm.createContext({k,window,Ne:()=>ctx,ASn:(type,props,...children)=>({type,props:props||{},children}),ASicon:()=>null,
  K:{dispatch:async p=>{dispatched.push(p);return {id:'t1'}}},st:{copyText:async t=>{copied.push(t)}},
  arUseTranscript:()=>({sessionId:session,cwd:'/srv/app/src',messages:[]}),arWorkspace:()=>({openFile:p=>opened.push(p)}),ArchonGitModel:Model,JSON,Date,Math,String,document:{getElementById:()=>null}});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../git-renderer.js'),'utf8')+'\nthis.render=ArchonGit;',context);
 const settle=async()=>{for(let i=0;i<6;i++){await new Promise(r=>setImmediate(r))}};
 const render=async()=>{for(let round=0;round<5;round++){cursor=0;const tree=context.render({visible:true});const effects=pending;pending=[];effects.forEach(f=>f());await settle();if(!effects.length)break}cursor=0;return context.render({visible:true})};
 return {ctx,seen,said,confirms,dispatched,copied,opened,render};
}
function nodes(tree){if(!tree||typeof tree!=='object')return [];return [tree,...(tree.children||[]).flat(Infinity).flatMap(nodes)]}
function text(n){return nodes(n).flatMap(x=>x.children.filter(c=>typeof c==='string'||typeof c==='number')).join('')}
const byLabel=(tree,label)=>nodes(tree).find(n=>n.props['aria-label']===label);
const button=(tree,label)=>nodes(tree).find(n=>n.type==='button'&&text(n).trim()===label);

test('the panel opens the session repository and groups its changes',async()=>{
 const h=harness();const tree=await h.render();
 assert.deepEqual(JSON.parse(JSON.stringify(h.seen[0])),{op:'gitStatus',payload:{path:'/srv/app/src'}});
 const all=text(tree);
 assert.match(all,/main/);assert.match(all,/↑1 ↓0/);assert.match(all,/Staged · 1/);assert.match(all,/Changes · 2/);
 assert.ok(button(tree,'Commit 1 staged').props.disabled,'Commit waits for a message');
});

test('stage, confirmed discard and commit go to the repository root',async()=>{
 const h=harness();let tree=await h.render();
 byLabel(tree,'Stage src/a.ts').props.onClick();await h.render();
 assert.deepEqual(JSON.parse(JSON.stringify(h.seen.at(-1))),{op:'gitStage',payload:{path:'/srv/app',files:['src/a.ts']}});
 tree=await h.render();byLabel(tree,'Discard src/a.ts').props.onClick();
 assert.equal(h.confirms.length,1);assert.equal(h.confirms[0].danger,true);assert.ok(!h.seen.some(x=>x.op==='gitDiscard'));
 h.confirms[0].onConfirm();await h.render();
 assert.deepEqual(JSON.parse(JSON.stringify(h.seen.find(x=>x.op==='gitDiscard'))),{op:'gitDiscard',payload:{path:'/srv/app',files:['src/a.ts'],confirm:true}});
 tree=await h.render();byLabel(tree,'Commit message').props.onChange({target:{value:'Fix a'}});tree=await h.render();
 button(tree,'Commit 1 staged').props.onClick();tree=await h.render();
 assert.deepEqual(JSON.parse(JSON.stringify(h.seen.find(x=>x.op==='gitCommit'))),{op:'gitCommit',payload:{path:'/srv/app',message:'Fix a'}});
 assert.ok(h.said.includes('Committed def456'));assert.equal(byLabel(tree,'Commit message').props.value,'');
});

test('a file diff can be commented on and the review sent to the session agent',async()=>{
 const h=harness();let tree=await h.render();
 nodes(tree).find(n=>n.type==='button'&&n.props.title==='src/a.ts').props.onClick();tree=await h.render();
 assert.deepEqual(JSON.parse(JSON.stringify(h.seen.find(x=>x.op==='gitDiff'))),{op:'gitDiff',payload:{path:'/srv/app',scope:'unstaged',file:'src/a.ts'}});
 assert.match(text(tree),/new/);
 byLabel(tree,'Comment on line 1').props.onClick();tree=await h.render();
 byLabel(tree,'Review comment').props.onChange({target:{value:'Handle the empty case'}});tree=await h.render();
 nodes(tree).find(n=>n.type==='form'&&n.props.className==='ar-git-editor').props.onSubmit({preventDefault(){}});tree=await h.render();
 assert.match(text(tree),/1 review comment/);
 await button(tree,'Send to agent').props.onClick();tree=await h.render();
 assert.equal(h.dispatched.length,1);
 const sent=h.dispatched[0];assert.equal(sent.sessionId,'s1');assert.equal(sent.cwd,'/srv/app/src');assert.equal(sent.profile,null);
 assert.match(sent.prompt,/Code review of working-tree changes in app/);assert.match(sent.prompt,/src\/a\.ts:\d+/);assert.match(sent.prompt,/Handle the empty case/);
 assert.ok(h.said.includes('Review sent to the agent'));assert.doesNotMatch(text(tree),/review comment/);
});

test('without a session the review is copied instead of sent',async()=>{
 const h=harness({session:''});let tree=await h.render();
 nodes(tree).find(n=>n.type==='button'&&n.props.title==='src/a.ts').props.onClick();tree=await h.render();
 byLabel(tree,'Comment on line 1').props.onClick();tree=await h.render();
 byLabel(tree,'Review comment').props.onChange({target:{value:'Rename'}});tree=await h.render();
 nodes(tree).find(n=>n.props.className==='ar-git-editor').props.onSubmit({preventDefault(){}});tree=await h.render();
 await button(tree,'Copy for agent').props.onClick();
 assert.equal(h.dispatched.length,0);assert.match(h.copied[0],/Rename/);
});

test('secret files never render content and a missing repository explains itself',async()=>{
 const h=harness();let tree=await h.render();
 nodes(tree).find(n=>n.type==='button'&&n.props.title==='.env').props.onClick();tree=await h.render();
 assert.match(text(tree),/Secret-bearing file — content is not shown\./);
 const missing=harness({calls:{gitStatus:()=>{throw Error('GET /api/git/status → 404: /home/archon is not inside a Git repository')}}});
 assert.match(text(await missing.render()),/Git unavailable here.*not inside a Git repository/);
});
