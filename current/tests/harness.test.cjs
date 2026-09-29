const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {patchHarnesses}=require('../harness-patch.cjs');
const {patchRuntimes}=require('../runtime-patch.cjs');
const {patchMain}=require('../main-ops-patch.cjs');
const baseline=require('../baseline.json');

const rows=()=>[
 {id:'prime',label:'Prime',description:'d',executable:'/bin/prime-agent',installed:true,version:'0.9.6',enabled:true,ready:true,default_model:null,signed_in:['deepseek'],sessions:4,running:1,package:null,can_update:false,latest:null,update_available:false,updating:false},
 {id:'pi',label:'Pi',description:'d',executable:'/bin/pi',installed:true,version:'0.87.1',enabled:false,ready:false,default_model:null,signed_in:[],sessions:0,running:0,package:'@earendil-works/pi-coding-agent',can_update:true,latest:'0.88.0',update_available:true,updating:false},
 {id:'opencode',label:'OpenCode',description:'d',executable:'/bin/opencode',installed:false,version:null,enabled:true,ready:false,default_model:'opencode/big-pickle',signed_in:[],sessions:2,running:0,package:'opencode-ai',can_update:true,latest:null,update_available:false,updating:false},
];

function harness(connected=true){
 let cursor=0,slots=[],pending=[];const calls=[],said=[],confirms=[];
 const ctx={connected,say:m=>said.push(m),confirm:c=>confirms.push(c),data:{models:[{id:'opencode/big-pickle',provider:'opencode'},{id:'opencode/nemotron-3-ultra-free',provider:'opencode'},{id:'gpt-5.6-sol',provider:'openai-codex'}]}};
 const useState=initial=>{const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return [slots[i],v=>{slots[i]=typeof v==='function'?v(slots[i]):v}]};
 let store=null;
 const k={Fragment:'fragment',useState,useSyncExternalStore:(sub,snap)=>{store=store||sub;return snap()},useEffect(fn,deps){const i=cursor++,old=slots[i];if(!old||deps.some((d,n)=>d!==old.deps[n]))pending.push(()=>{slots[i]={deps,cleanup:fn()}})}};
 const data=rows();
 const api={call:async(op,p)=>{calls.push({op,p:JSON.parse(JSON.stringify(p||{}))});if(op==='harnesses')return {harnesses:data};const row={...data.find(r=>r.id===p.id)};
  if(op==='harnessConfigure'){if('enabled' in p){row.enabled=p.enabled;row.ready=row.installed&&p.enabled}if('default_model' in p)row.default_model=p.default_model||null}
  if(op==='harnessCheck')Object.assign(row,{ok:true,problems:[]});
  if(op==='harnessUpdate')Object.assign(row,{version:'0.88.0',update_available:false});
  return row}};
 const context=vm.createContext({k,window:{archon:{api}},Ne:()=>ctx,ASn:(type,props,...children)=>({type,props:props||{},children}),ASicon:()=>null,ASsection:'section',ArchonGitModel:require('../git-model.cjs'),JSON,Set});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../harness-renderer.js'),'utf8')+'\nthis.page=ArchonHarnesses;this.store=ArchonHarnessStore;',context);
 const settle=async()=>{for(let i=0;i<5;i++)await new Promise(r=>setImmediate(r))};
 const render=async()=>{for(let n=0;n<4;n++){cursor=0;context.page();const effects=pending;pending=[];effects.forEach(f=>f());await settle();if(!effects.length)break}cursor=0;return context.page()};
 return {render,calls,said,confirms,store:context.store};
}
const nodes=t=>!t||typeof t!=='object'?[]:[t,...(t.children||[]).flat(Infinity).flatMap(nodes)];
const text=t=>nodes(t).flatMap(n=>n.children.filter(c=>typeof c==='string'||typeof c==='number')).join(' ');
const card=(tree,label)=>nodes(tree).find(n=>n.type==='article'&&n.props['aria-label']===label);
const button=(tree,label)=>nodes(tree).find(n=>n.type==='button'&&text(n).trim()===label);

test('each harness shows its state, version, sign-ins and usage',async()=>{
 const h=harness();const tree=await h.render();
 assert.match(text(card(tree,'Prime')),/Ready .*0\.9\.6.*deepseek.*4 · 1 running.*Updated by its own installer/s);
 assert.match(text(card(tree,'Pi')),/Off .*0\.87\.1 · 0\.88\.0 available.*No saved sign-ins/s);
 assert.match(text(card(tree,'OpenCode')),/Not installed/);
 assert.equal(h.store.off('pi'),true);assert.equal(h.store.off('prime'),false);assert.equal(h.store.off('opencode'),true);
});

test('switching, default model, check and confirmed update call the MiniPC',async()=>{
 const h=harness();let tree=await h.render();
 nodes(card(tree,'Pi')).find(n=>n.props.role==='switch').props.onClick();tree=await h.render();
 assert.deepEqual(h.calls.at(-1),{op:'harnessConfigure',p:{id:'pi',enabled:true}});
 assert.ok(h.said.includes('Pi turned on'));assert.equal(h.store.off('pi'),false);
 const select=nodes(card(tree,'OpenCode')).find(n=>n.type==='select');
 assert.deepEqual(nodes(select).filter(n=>n.type==='option').map(n=>n.props.value),['','opencode/big-pickle','opencode/nemotron-3-ultra-free']);
 select.props.onChange({target:{value:'opencode/nemotron-3-ultra-free'}});tree=await h.render();
 assert.deepEqual(h.calls.at(-1),{op:'harnessConfigure',p:{id:'opencode',default_model:'opencode/nemotron-3-ultra-free'}});
 button(card(tree,'Prime'),'Check').props.onClick();tree=await h.render();
 assert.match(text(card(tree,'Prime')),/Healthy/);
 button(card(tree,'Pi'),'Update to 0.88.0').props.onClick();
 assert.equal(h.confirms.length,1);assert.ok(!h.calls.some(c=>c.op==='harnessUpdate'));
 h.confirms[0].onConfirm();tree=await h.render();
 assert.deepEqual(h.calls.at(-1),{op:'harnessUpdate',p:{id:'pi',confirm:true}});
 assert.match(text(card(tree,'Pi')),/Updated to 0\.88\.0/);
 assert.equal(button(card(tree,'Prime'),'Check').props.disabled,false);
});

test('while disconnected nothing can be changed',async()=>{
 const h=harness(false);const tree=await h.render();
 assert.match(text(tree),/Connect to the MiniPC/);
 assert.ok(nodes(tree).filter(n=>n.props.role==='switch').every(n=>n.props.disabled));
});

test('main process routes harness operations',async()=>{
 const seen=[];let handler;
 const api={baseUrl:'http://s',headers:()=>({}),qs:()=>'',call:async()=>'bridge'};
 const fetch=async(url,init)=>{seen.push([init.method,url.slice(8),init.body&&JSON.parse(init.body)]);return {status:200,ok:true,text:async()=>'{}'}};
 vm.runInNewContext(patchMain('var api = new ArchonApi();\nimport_electron3.ipcMain.handle("api:call", (_e, op, payload) => api.call(op, payload ?? {}));').replace('var api = new ArchonApi();',''),{api,fetch,AbortSignal,import_electron3:{ipcMain:{handle:(_,fn)=>{handler=fn}}}});
 await handler(null,'harnesses');await handler(null,'harnessConfigure',{id:'pi',enabled:false,junk:1});
 await handler(null,'harnessCheck',{id:'open code'});await handler(null,'harnessUpdate',{id:'pi',confirm:'yes'});
 assert.deepEqual(seen,[['GET','/api/harnesses',undefined],['PUT','/api/harnesses/pi',{enabled:false}],['POST','/api/harnesses/open%20code/check',{}],['POST','/api/harnesses/pi/update',{confirm:false}]]);
});

const archive=process.env.ARCHON_V030_ASAR;
test('the renderer gains the settings page and respects turned-off agents',{skip:!archive},()=>{
 const renderer=patchRuntimes(require('@electron/asar').extractFile(archive,baseline.rendererPath).toString());
 const out=patchHarnesses(renderer);
 for(const marker of ["{id:'harnesses', group:'WORKSPACE'","tab==='harnesses'?ASn(ArchonHarnesses)","disabled:ArchonHarnessStore.off(id),title:","'TURNED OFF'",'disabled:ArchonHarnessStore.off(id),onClick:()=>{patch('])assert.ok(out.includes(marker),marker);
 assert.throws(()=>patchHarnesses(out),/Harness/);
});
