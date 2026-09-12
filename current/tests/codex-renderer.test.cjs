const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

function helpers(){
 const context=vm.createContext({window:{},k:{},Date,Set,Map});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../codex-renderer.js'),'utf8')+'\nthis.helpers=ArchonCodex;',context);
 return context.helpers;
}
const plain=value=>JSON.parse(JSON.stringify(value));
const models=[{id:'remote-model',provider:'openai-codex'},{id:'local-model',provider:'codex'}];

test('Codex selection uses local models and clears a remote project',()=>{
 const h=helpers(),s={agentRuntime:'prime',model:'remote-model',modelProvider:'openai-codex',activeProject:'remote-project',defaultCwd:'/remote'};
 const selected={...s,...h.selection(s,'codex',models)};
 assert.equal(selected.agentRuntime,'codex');assert.equal(selected.modelProvider,'codex');
 assert.equal(selected.model,'local-model');assert.equal(selected.activeProject,null);assert.equal(selected.defaultCwd,'.');
 const restored=h.selection(selected,'prime',models);assert.equal(restored.model,'remote-model');assert.equal(restored.defaultCwd,'/remote');
});
test('existing sessions retain runtime and compatible model when the picker changes',()=>{
 const h=helpers(),s={agentRuntime:'codex',model:'local-model',modelProvider:'codex',runtimeModels:{prime:{model:'remote-model',provider:'openai-codex'}}};
 assert.deepEqual(plain(h.dispatchOptions(s,{id:'prime-1',runtime:'prime'})),{profile:null,model:'remote-model',provider:'openai-codex'});
 assert.deepEqual(plain(h.dispatchOptions({...s,agentRuntime:'prime'},{id:'codex:one',runtime:'codex'})),{profile:'codex',model:'local-model',provider:'codex'});
 assert.equal(h.sessionRuntime({id:'codex:one'}),'codex');
 assert.equal(h.sessionRuntime({id:'pi-native-one',source:'pi-cli'}),'pi');
});
test('Codex dispatch refuses a remote project and isolates local project metadata',()=>{
 const h=helpers(),s={agentRuntime:'codex',model:'local-model',modelProvider:'codex',activeProject:'remote-project'};
 assert.throws(()=>h.newPayload('hello','/remote',s),/local Codex project/i);
 assert.equal(h.newPayload('hello','/local',{...s,activeProject:'codex-project:one'}).profile,'codex');
 assert.equal(h.runtime({agentRuntime:'prime',activeProject:'codex-project:one'}),'codex');
 assert.equal(h.browserContext({...s,activeProject:'codex-project:one',defaultCwd:'/remote'}).projectId,'codex-project:one');
 assert.equal(h.browserContext({...s,activeProject:'codex-project:one',defaultCwd:'/remote'}).cwd,null);
 assert.throws(()=>h.browserContext(s),/local Codex project/i);
});
test('offline hydration updates local rows without fabricating remote connection status',()=>{
 const h=helpers(),old={projects:[{id:'remote-project'}],sessions:[{id:'remote-one'},{id:'codex:old'}],tasks:[{id:'remote-task'}],models:models,chats:[],thread:[]};
 const snap={projects:[{id:'codex-project:one',name:'local'}],sessions:[{id:'codex:new',projectId:'codex-project:one'}],tasks:[],models:[models[1]]};
 const result=h.mergeLocal(old,snap,{});
 assert.deepEqual(plain(result.sessions.map(s=>s.id)),['remote-one','codex:new']);
 assert.equal(result.sessions[1].project,'local');assert.ok(!('connected' in result));
});
test('Codex model filtering does not offer remote providers',()=>{
 const h=helpers();assert.deepEqual(plain(h.models(models,'codex')),[models[1]]);assert.deepEqual(plain(h.models(models,'pi')),[models[0]]);
});
test('attachment scope follows the visible session rather than the new-session picker',()=>{
 const h=helpers();
 assert.equal(h.activeRuntime({agentRuntime:'prime'},{sessionId:'codex:one'},{sessions:[]}),'codex');
 assert.equal(h.activeRuntime({agentRuntime:'codex'},{sessionId:'remote-one'},{sessions:[{id:'remote-one',runtime:'pi'}]}),'pi');
});
test('local conversation history remains readable with the MiniPC server offline',()=>{
 const h=helpers();assert.equal(h.sessionAccessible(false,{id:'codex:one'}),true);assert.equal(h.sessionAccessible(false,{id:'remote-one'}),false);assert.equal(h.sessionAccessible(true,{id:'remote-one'}),true);
});

const archive=process.env.ARCHON_V030_ASAR;
test('the existing model screen selects Codex and shows only its usable local models',{skip:!archive},async()=>{
 const {patchCodexRenderer}=require('../codex-patch.cjs');
 const base=require('@electron/asar').extractFile(archive,require('../baseline.json').rendererPath).toString();
 const patched=patchCodexRenderer(base),start=patched.indexOf('function ASModels(){'),end=patched.indexOf('function ASConnection(){',start);
 let settings={agentRuntime:'prime',model:'remote-model',modelProvider:'openai-codex',activeProject:'remote-project',defaultCwd:'/remote',pinnedModels:[]},cursor=0,slots=[];
 const k={useState(value){const slot=cursor++;if(!(slot in slots))slots[slot]=value;return [slots[slot],value=>slots[slot]=value]},useSyncExternalStore:(_,snapshot)=>snapshot()};
 const context=vm.createContext({window:{archon:{api:{call:async()=>({available:true,authenticated:true})}}},k,
  Ne:()=>({settings,data:{models},connected:false,patch:value=>settings={...settings,...value}}),
  ASn:(type,props,...children)=>({type,props:props||{},children}),ASicon:()=>null,ASsection:()=>null});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../codex-renderer.js'),'utf8')+'\n'+patched.slice(start,end)+'\nthis.helpers=ArchonCodex;this.render=ASModels;',context);
 await context.helpers.check();
 function nodes(tree){return tree&&typeof tree==='object'?[tree,...(tree.children||[]).flat(Infinity).flatMap(nodes)]:[]}
 const render=()=>{cursor=0;return context.render()};
 let tree=render();nodes(tree).find(node=>node.props.key==='codex').props.onClick();
 assert.equal(settings.agentRuntime,'codex');assert.equal(settings.activeProject,null);assert.equal(settings.modelProvider,'codex');
 tree=render();const options=nodes(tree).filter(node=>String(node.props['aria-label']||'').startsWith('Select '));
 assert.deepEqual(options.map(node=>node.props['aria-label']),['Select local-model']);
 assert.equal(options[0].props.disabled,false);options[0].props.onClick();
 assert.equal(settings.runtimeModels.codex.model,'local-model');
});
test('Codex patch covers dispatch, roster, history, and offline hydration with guarded anchors',{skip:!archive},()=>{
 const {patchCodexRenderer}=require('../codex-patch.cjs');
 const base=require('@electron/asar').extractFile(archive,require('../baseline.json').rendererPath).toString();
 const patched=patchCodexRenderer(base);
 assert.match(patched,/codexProjectCreate|runtime:ArchonCodex\.runtime/);
 assert.match(patched,/ArchonCodex\.dispatchOptions\(n,E\)/);
 assert.match(patched,/ArchonCodex\.snapshot/);
 assert.match(patched,/\['codex','Codex'|\["codex","Codex"/);
 assert.match(patched,/ArchonCodex\.label\(SSagent\(\$\)\)/);
 assert.ok(!/profile:[a-z]\.agentRuntime==="pi"\?"pi":null/.test(patched));
 assert.throws(()=>patchCodexRenderer(base.replace('function ASModels(){','function MissingModels(){')),/models component/);
 const checked=require('node:child_process').spawnSync(process.execPath,['--input-type=module','--check'],{input:patched,encoding:'utf8'});
 assert.equal(checked.status,0,checked.stderr);
});
