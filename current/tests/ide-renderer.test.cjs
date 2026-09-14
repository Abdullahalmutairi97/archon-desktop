const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const Model=require('../ide-model.cjs');

function harness(){
 let cursor=0,slots=[],pending=[];const calls=[];
 const listeners=new Map(),ctx={ui:{bench:'ide',view:'sessions'},settings:{serverUrl:'server-a',lang:'en'},connected:true,say(){},confirm(){},setUi(){}};
 const useState=initial=>{const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return [slots[i],v=>{slots[i]=typeof v==='function'?v(slots[i]):v}]};
 const k={Fragment:'fragment',useState,useRef:v=>useState(()=>({current:v}))[0],useMemo:fn=>fn(),useSyncExternalStore:(_,snapshot)=>snapshot(),useEffect(fn,deps){const i=cursor++,old=slots[i];if(!old||deps.some((d,n)=>d!==old.deps[n])){pending.push(()=>{old?.cleanup?.();slots[i]={deps,cleanup:fn()}})}}};
 const window={archon:{api:{call:async(op,payload)=>{calls.push({op,payload});return op==='codexFiles'?{items:[{name:'tool.py',path:'/local/project/tool.py',is_dir:false}]}:{content:'saved'}}}},innerWidth:1000,addEventListener:(n,f)=>listeners.set(n,f),removeEventListener:(n,f)=>{if(listeners.get(n)===f)listeners.delete(n)}};
 const K={files:()=>{calls.push({op:'remoteFiles'});return new Promise(()=>{})},readFileWindow:async()=>{calls.push({op:'remoteRead'});return {content:'saved'}},writeFile:async()=>{calls.push({op:'remoteWrite'})}};
 const context=vm.createContext({k,r:k,window,K,ArchonIdeModel:Model,Ne:()=>ctx,ASn:(type,props,...children)=>({type,props:props||{},children}),ASicon:()=>null,Qm:[],Zm:'activity',pf:'files',uf:'browser',qm:'notes',ey:'terminal'});
 vm.runInContext(fs.readFileSync(require.resolve('../ide-renderer.js'),'utf8')+'\nthis.renderIde=ArchonIde;this.renderBench=ArchonWorkbench;this.workspace=arWorkspace;this.publishTranscript=arPublish;',context);
 return {ctx,listeners,calls,workspace:context.workspace,publish:context.publishTranscript,render(component='renderIde'){cursor=0;const tree=context[component]({});const effects=pending;pending=[];effects.forEach(f=>f());return tree}};
}
function nodes(tree){if(!tree||typeof tree!=='object')return [];return [tree,...(tree.children||[]).flat(Infinity).flatMap(nodes)]}
function strings(tree){return nodes(tree).flatMap(n=>n.children.filter(c=>typeof c==='string'))}
test('disconnecting while explorer loads clears its loading indicator',()=>{
 const h=harness();h.render();assert.ok(strings(h.render()).includes('Loading…'));
 h.ctx.connected=false;h.render();assert.ok(!strings(h.render()).includes('Loading…'));
});
test('unsaved tabs on another server still protect window close',async()=>{
 const h=harness(),w=h.workspace('server-a');await w.openFile('/file.ts');w.edit('/file.ts','draft');h.render();
 h.ctx.settings={serverUrl:'server-b',lang:'en'};h.render();
 let prevented=false;h.listeners.get('beforeunload')({preventDefault(){prevented=true}});assert.equal(prevented,true);
});
test('keyboard resizing clamps width to viewport and respects RTL',()=>{
 const h=harness();let tree=h.render('renderBench');
 for(let i=0;i<15;i++){nodes(tree).find(n=>n.props.role==='separator').props.onKeyDown({key:'ArrowLeft',preventDefault(){}});tree=h.render('renderBench')}
 assert.equal(nodes(tree).find(n=>n.props.role==='separator').props['aria-valuenow'],960);
 h.ctx.settings.lang='ar';tree=h.render('renderBench');nodes(tree).find(n=>n.props.role==='separator').props.onKeyDown({key:'ArrowLeft',preventDefault(){}});tree=h.render('renderBench');
 assert.equal(nodes(tree).find(n=>n.props.role==='separator').props['aria-valuenow'],920);
});
test('local Codex files use an explicit session root while the remote server is offline',async()=>{
 const h=harness();h.ctx.connected=false;h.ctx.ui={view:'thread',sessionId:'codex:test',bench:'ide'};
 h.publish({sessionId:'codex:test',server:'server-a',cwd:'/local/project',messages:[]});h.render();h.render();await Promise.resolve();
 const w=h.workspace('server-a','codex:test');await w.openFile('/local/project/tool.py');w.edit('/local/project/tool.py','local draft');await w.save('/local/project/tool.py');
 const tree=h.render();assert.ok(strings(tree).includes('This PC'));
 assert.equal(nodes(tree).find(n=>n.type==='button'&&n.children.includes('Terminal')).props.disabled,true);
 assert.ok(h.calls.some(x=>x.op==='codexFiles'));assert.ok(h.calls.some(x=>x.op==='codexFileWrite'&&x.payload.content==='local draft'));
 assert.ok(h.calls.every(x=>x.op.startsWith('codex')&&x.payload.sessionId==='codex:test'));
});
test('changing to a local session reloads the explorer before transcript effects settle',async()=>{
 const h=harness();h.ctx.connected=false;h.ctx.ui={view:'thread',sessionId:'codex:direct',bench:'ide'};
 h.render();h.render();await Promise.resolve();
 assert.ok(h.calls.some(x=>x.op==='codexFiles'&&x.payload.sessionId==='codex:direct'));
 assert.ok(!h.calls.some(x=>x.op==='remoteFiles'));
});
test('local and remote workspaces never share buffers or file transports',async()=>{
 const h=harness(),remote=h.workspace('server-a');await remote.openFile('/same.py');remote.edit('/same.py','remote draft');
 const local=h.workspace('server-a','codex:test');await local.openFile('/same.py');local.edit('/same.py','local draft');
 assert.equal(remote.snapshot().docs['/same.py'].text,'remote draft');assert.equal(local.snapshot().docs['/same.py'].text,'local draft');
 await remote.save('/same.py');assert.match(remote.snapshot().docs['/same.py'].error,/Connection changed/);
 assert.equal(h.calls.filter(x=>x.op==='remoteWrite').length,0);
});
test('local Files and Terminal panels never mount their remote counterparts',()=>{
 const h=harness();h.ctx.ui={view:'thread',sessionId:'codex:test',bench:'files'};
 h.publish({sessionId:'codex:test',server:'server-a',cwd:'/local/project',messages:[]});
 const files=h.render('renderBench');assert.equal(nodes(files).filter(n=>n.type==='files').length,0);
 assert.ok(nodes(files).some(n=>n.props.visible===true));
 h.ctx.ui.bench='terminal';const terminal=h.render('renderBench');assert.equal(nodes(terminal).filter(n=>n.type==='terminal').length,0);
 assert.ok(strings(terminal).some(text=>text.includes('ask Codex to run commands')));
});
