const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const Model=require('../ide-model.cjs');

function harness(){
 let cursor=0,slots=[],pending=[];
 const listeners=new Map(),ctx={ui:{bench:'ide',view:'sessions'},settings:{serverUrl:'server-a',lang:'en'},connected:true,say(){},confirm(){},setUi(){}};
 const useState=initial=>{const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return [slots[i],v=>{slots[i]=typeof v==='function'?v(slots[i]):v}]};
 const k={Fragment:'fragment',useState,useRef:v=>useState(()=>({current:v}))[0],useMemo:fn=>fn(),useSyncExternalStore:(_,snapshot)=>snapshot(),useEffect(fn,deps){const i=cursor++,old=slots[i];if(!old||deps.some((d,n)=>d!==old.deps[n])){pending.push(()=>{old?.cleanup?.();slots[i]={deps,cleanup:fn()}})}}};
 const window={innerWidth:1000,addEventListener:(n,f)=>listeners.set(n,f),removeEventListener:(n,f)=>{if(listeners.get(n)===f)listeners.delete(n)}};
 const K={files:()=>new Promise(()=>{}),readFileWindow:async()=>({content:'saved'}),writeFile:async()=>{}};
 const context=vm.createContext({k,r:k,window,K,ArchonIdeModel:Model,Ne:()=>ctx,ASn:(type,props,...children)=>({type,props:props||{},children}),ASicon:()=>null,Qm:[],Zm:'activity',pf:'files',uf:'browser',qm:'notes',ey:'terminal'});
 vm.runInContext(fs.readFileSync(require.resolve('../ide-renderer.js'),'utf8')+'\nthis.renderIde=ArchonIde;this.renderBench=ArchonWorkbench;this.workspace=arWorkspace;',context);
 return {ctx,listeners,workspace:context.workspace,render(component='renderIde'){cursor=0;const tree=context[component]({});const effects=pending;pending=[];effects.forEach(f=>f());return tree}};
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
