const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const Model=require('../ide-model.cjs');

function harness(){
 let cursor=0,slots=[],pending=[];const calls=[];
 const listeners=new Map(),ctx={ui:{bench:'ide',view:'sessions'},settings:{serverUrl:'server-a',lang:'en'},connected:true,say(){},confirm(){},setUi(){}};
 const useState=initial=>{const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return [slots[i],v=>{slots[i]=typeof v==='function'?v(slots[i]):v}]};
 const k={Fragment:'fragment',useState,useRef:v=>useState(()=>({current:v}))[0],useMemo:fn=>fn(),useSyncExternalStore:(_,snapshot)=>snapshot(),useEffect(fn,deps){const i=cursor++,old=slots[i];if(!old||deps.some((d,n)=>d!==old.deps[n])){pending.push(()=>{old?.cleanup?.();slots[i]={deps,cleanup:fn()}})}}};
 const window={archon:{api:{call:async(op,payload)=>{calls.push({op,payload});return {}}}},innerWidth:1000,addEventListener:(n,f)=>listeners.set(n,f),removeEventListener:(n,f)=>{if(listeners.get(n)===f)listeners.delete(n)}};
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
test('every session uses the server file transport and mounts the server panels',async()=>{
 const h=harness();h.ctx.ui={view:'thread',sessionId:'codex:legacy',bench:'ide'};
 h.publish({sessionId:'codex:legacy',server:'server-a',cwd:'/project',messages:[]});h.render();h.render();await Promise.resolve();
 const w=h.workspace('server-a');await w.openFile('/project/tool.py');w.edit('/project/tool.py','draft');await w.save('/project/tool.py');
 const tree=h.render();assert.ok(strings(tree).includes('Connected'));
 assert.notEqual(nodes(tree).find(n=>n.type==='button'&&n.children.includes('Terminal')).props.disabled,true);
 assert.ok(h.calls.some(x=>x.op==='remoteFiles'));assert.ok(h.calls.some(x=>x.op==='remoteWrite'));
 assert.ok(!h.calls.some(x=>String(x.op).startsWith('codex')));
 h.ctx.ui.bench='files';assert.equal(nodes(h.render('renderBench')).filter(n=>n.type==='files').length,1);
 h.ctx.ui.bench='terminal';assert.equal(nodes(h.render('renderBench')).filter(n=>n.type==='terminal').length,1);
});
