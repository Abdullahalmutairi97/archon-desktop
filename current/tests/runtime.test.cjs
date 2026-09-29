const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {patchRuntimes}=require('../runtime-patch.cjs');
const baseline=require('../baseline.json');

const context=vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../runtime-renderer.js'),'utf8')+'\nthis.R=ArchonRuntime;',context);
const R=context.R;
const plain=v=>JSON.parse(JSON.stringify(v));
const models=[{id:'gpt-5.6-sol',provider:'openai-codex'},{id:'opencode/big-pickle',provider:'opencode'},{id:'opencode/nemotron-3-ultra-free',provider:'opencode'}];

test('sessions and profiles map to their agent and label',()=>{
 assert.equal(R.runtime({agentRuntime:'opencode'}),'opencode');assert.equal(R.runtime({agentRuntime:'codex'}),'prime');
 assert.equal(R.sessionRuntime({runtime:'opencode'}),'opencode');assert.equal(R.sessionRuntime({source:'pi-cli'}),'pi');assert.equal(R.sessionRuntime({}),'prime');
 assert.equal(R.byProfile('opencode'),'OpenCode');assert.equal(R.byProfile(null),'Prime');assert.equal(R.label('pi'),'Pi');
});

test('each agent only sees and dispatches models it can run',()=>{
 assert.deepEqual(plain(R.forRuntime(models,'opencode').map(m=>m.id)),['opencode/big-pickle','opencode/nemotron-3-ultra-free']);
 assert.deepEqual(plain(R.forRuntime(models,'pi').map(m=>m.id)),['gpt-5.6-sol']);
 const prime={agentRuntime:'prime',model:'gpt-5.6-sol',modelProvider:'openai-codex'};
 assert.deepEqual(plain(R.dispatch(prime)),{profile:null,model:'gpt-5.6-sol',provider:'openai-codex'});
 const switched={...prime,...R.selection(prime,'opencode',models)};
 assert.equal(switched.model,'opencode/big-pickle');assert.equal(switched.modelProvider,'opencode');
 assert.deepEqual(plain(R.dispatch(switched)),{profile:'opencode',model:'opencode/big-pickle',provider:'opencode'});
 const picked={...switched,...R.chooseModel(switched,models[2])};
 const back={...picked,...R.selection(picked,'prime',models)};
 assert.equal(back.model,'gpt-5.6-sol');
 const again={...back,...R.selection(back,'opencode',models)};
 assert.equal(again.model,'opencode/nemotron-3-ultra-free','OpenCode remembers its own model');
 assert.deepEqual(plain(R.dispatch(back,{id:'prime-1',runtime:'opencode'})),{profile:'opencode',model:'opencode/nemotron-3-ultra-free',provider:'opencode'},'a reply follows the session agent');
 assert.deepEqual(plain(R.dispatch({agentRuntime:'opencode',model:'gpt-5.6-sol',modelProvider:'openai-codex'})),{profile:'opencode',model:null,provider:null},'never sends a Prime model to OpenCode');
});

const archive=process.env.ARCHON_V030_ASAR;
test('the v0.3.0 renderer gains OpenCode wherever it named Prime and Pi',{skip:!archive},()=>{
 const renderer=require('@electron/asar').extractFile(archive,baseline.rendererPath).toString();
 const out=patchRuntimes(renderer);
 for(const marker of ["['opencode','OpenCode','ph-code'","['opencode','OpenCode']]",'function SSagent(s){return ArchonRuntime.sessionRuntime(s)}','approval:o.approval,...ArchonRuntime.dispatch(o)}}','...ArchonRuntime.dispatch(n,E)','ArchonRuntime.forRuntime(data.models,runtime)','function wy(){return ASn(ASModels)}','Start an OpenCode session'])assert.ok(out.includes(marker),marker);
 assert.ok(!/agentRuntime==="pi"\?"pi":null/.test(out),'every dispatch goes through ArchonRuntime');
 assert.throws(()=>patchRuntimes(out),/Runtime/);
 assert.throws(()=>patchRuntimes(renderer.replace("[['all','All'],['prime','Prime'],['pi','Pi']]",'[]')),/session filter/);
});
