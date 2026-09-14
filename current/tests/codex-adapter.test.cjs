const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {createCodexAdapter}=require('../codex-adapter.cjs');

async function fixture(t,extra={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'archon-codex-test-'));
 const sent=[],events=[],threads=new Map();let child,sequence=0;
 const spawn=()=>{
  child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>child.emit('exit',0);
  let buffer='';child.stdin.on('data',chunk=>{buffer+=chunk;let n;while((n=buffer.indexOf('\n'))>=0){const q=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);sent.push(q);if(!q.method||q.id===undefined)continue;
   let result={};
   if(q.method==='initialize')result={userAgent:'codex/0.test'};
   if(q.method==='account/read')result={account:{type:'chatgpt',email:'private@example.invalid'},requiresOpenaiAuth:true};
   if(q.method==='model/list')result={data:[{id:'available-model',model:'available-model',displayName:'Available',isDefault:true,hidden:false}],nextCursor:null};
   if(q.method==='thread/start'){const id='thread-'+(++sequence);const thread={id,cwd:q.params.cwd,turns:[],createdAt:100,updatedAt:100};threads.set(id,thread);result={thread,model:'available-model'};}
   if(q.method==='thread/read'||q.method==='thread/resume')result={thread:threads.get(q.params.threadId),model:'available-model'};
   if(q.method==='turn/start'){const turn={id:'turn-'+(++sequence),status:'inProgress',items:[{id:'user-'+sequence,type:'userMessage',content:q.params.input}]};threads.get(q.params.threadId).turns.push(turn);result={turn};}
   queueMicrotask(()=>{extra.beforeResponse?.(q,result,child);child.stdout.write(JSON.stringify({id:q.id,result})+'\n')});
  }});return child;
 };
 const options={userDataDir:dir,spawn,emit:e=>events.push(e),requestTimeoutMs:1000,...extra};
 const adapter=createCodexAdapter(options);
 t.after(async()=>{adapter.close();await fs.rm(dir,{recursive:true,force:true})});
 const call=(op,p={})=>adapter.call(op,p,async()=>[]);
 const notify=(method,params)=>child.stdout.write(JSON.stringify({method,params})+'\n');
 return {dir,adapter,options,call,events,sent,threads,notify,get child(){return child}};
}

test('initializes once and returns status without account identity or tokens',async t=>{
 const f=await fixture(t);const [a,b]=await Promise.all([f.call('codexStatus'),f.call('codexStatus')]);
 assert.equal(a.authenticated,true);assert.deepEqual(a,b);assert.equal(JSON.stringify(a).includes('private@'),false);
 assert.equal(f.sent.filter(q=>q.method==='initialize').length,1);
 assert.ok(f.sent.find(q=>q.method==='initialized'));
 assert.deepEqual((await f.call('codexModels')).models.map(m=>m.model),['available-model']);
});

test('creates a real protocol turn, streams messages, stops and retains project mapping',async t=>{
 const f=await fixture(t);const project=(await f.call('codexProjectCreate',{name:'Mini project',path:path.join(f.dir,'mini')})).project;
 const {task}=await f.call('taskCreate',{profile:'codex',projectId:project.id,prompt:'Create a greeting',approval:'ask'});
 assert.match(task.session_id,/^codex:/);assert.equal(task.status,'running');
 const start=f.sent.find(q=>q.method==='thread/start');assert.equal(start.params.sandbox,'workspace-write');assert.equal(start.params.approvalPolicy,'on-request');
 const threadId=task.session_id.slice(6),turnId=f.threads.get(threadId).turns[0].id;
 f.notify('item/agentMessage/delta',{threadId,turnId,itemId:'reply',delta:'Hello'});
 assert.equal(f.events.find(e=>e.kind==='message.delta').data.text,'Hello');
 await f.call('taskCancel',{id:task.id});assert.equal(f.sent.find(q=>q.method==='turn/interrupt').params.turnId,turnId);
 f.notify('turn/completed',{threadId,turn:{id:turnId,status:'interrupted',items:[]}});
 assert.ok(f.events.find(e=>e.kind==='task.cancelled'));
 assert.equal((await f.call('sessions'))[0].project_id,project.id);
});

test('maps durable Codex history and resumes only Archon-owned sessions',async t=>{
 const f=await fixture(t);const {task}=await f.call('taskCreate',{profile:'codex',cwd:f.dir,prompt:'One'});
 const thread=f.threads.get(task.session_id.slice(6));thread.turns[0].status='completed';thread.turns[0].items.push({id:'reply',type:'agentMessage',text:'First answer'});
 f.notify('turn/completed',{threadId:thread.id,turn:thread.turns[0]});
 assert.equal((await f.call('messages',{sessionId:task.session_id}))[1].content,'First answer');
 await f.call('taskCreate',{sessionId:task.session_id,prompt:'Two'});assert.ok(f.sent.find(q=>q.method==='thread/resume'));
 await assert.rejects(f.call('messages',{sessionId:'codex:foreign-thread'}),/Unknown Codex session/);
 const metadata=await fs.readFile(path.join(f.dir,'codex-sessions.json'),'utf8');assert.ok(!metadata.includes('First answer'));
});

test('remote operations are delegated unchanged and local snapshots survive remote failures',async t=>{
 const f=await fixture(t);let got;
 assert.equal(await f.adapter.call('files',{path:'/remote'},async(op,p)=>{got=[op,p];return 'remote'}),'remote');
 assert.deepEqual(got,['files',{path:'/remote'}]);
 const local=await f.call('codexProjectCreate',{name:'Local',path:path.join(f.dir,'local')});
 const projects=await f.adapter.call('projects',{},async()=>{throw Error('offline')});assert.equal(projects[0].id,local.project.id);
});

test('merging Codex models preserves the release API choices and items envelopes',async t=>{
 const f=await fixture(t),remote={model:'remote-model',provider:'openai-codex'};
 for(const envelope of [{choices:[remote],default:{provider:'openai-codex',model:'remote-model'}},{items:[remote]},[remote]]){
  const merged=await f.adapter.call('models',{},async()=>envelope);
  assert.deepEqual(merged.filter(m=>m.provider!=='codex'),[remote]);
  assert.deepEqual(merged.filter(m=>m.provider==='codex').map(m=>m.model),['available-model']);
 }
 for(const op of ['sessions','tasks','projects','agents']){
  const entry={id:`remote-${op}`},merged=await f.adapter.call(op,{},async()=>({items:[entry]}));
  assert.ok(merged.some(row=>row.id===entry.id),op);
 }
});

test('scopes local file access to an owned session and blocks escaping symlinks',async t=>{
 const f=await fixture(t);const root=path.join(f.dir,'work');await fs.mkdir(root);await fs.writeFile(path.join(root,'hello.ts'),'hello');
 const {task}=await f.call('taskCreate',{profile:'codex',cwd:root,prompt:'Read files'});
 assert.equal((await f.call('codexFileRead',{sessionId:task.session_id,path:'hello.ts'})).content,'hello');
 assert.equal((await f.call('codexFiles',{sessionId:task.session_id,path:'.'})).items[0].name,'hello.ts');
 await assert.rejects(f.call('codexFileRead',{sessionId:task.session_id,path:'../codex-sessions.json'}),/outside/);
 await fs.symlink(f.dir,path.join(root,'escape'));
 await assert.rejects(f.call('codexFileWrite',{sessionId:task.session_id,path:'escape/new.txt',content:'x'}),/outside/);
 await assert.rejects(f.call('codexFileRead',{path:path.join(root,'hello.ts')}),/Unknown Codex session/);
});

test('never treats unavailable approval UI as permission',async t=>{
 const f=await fixture(t);await f.call('codexStatus');
 f.child.stdout.write(JSON.stringify({id:91,method:'item/commandExecution/requestApproval',params:{threadId:'unknown',command:'anything'}})+'\n');
 await new Promise(resolve=>setImmediate(resolve));assert.equal(f.sent.find(q=>q.id===91).result.decision,'decline');
});

test('fails pending calls when app-server exits and permits a fresh status probe',async t=>{
 const f=await fixture(t);await f.call('codexStatus');f.child.emit('exit',1);
 assert.equal((await f.call('codexStatus')).available,true);assert.equal(f.sent.filter(q=>q.method==='initialize').length,2);
});

test('plan and chat turns remain read-only and auto never expands the sandbox',async t=>{
 for(const mode of [{approval:'plan'},{chatOnly:true},{approval:'auto'}]){
  const f=await fixture(t);await f.call('taskCreate',{profile:'codex',cwd:f.dir,prompt:'Check scope',...mode});
  const start=f.sent.find(q=>q.method==='thread/start').params,turn=f.sent.find(q=>q.method==='turn/start').params;
  assert.equal(start.sandbox,mode.approval==='auto'?'workspace-write':'read-only');
  assert.equal(turn.sandboxPolicy.type,mode.approval==='auto'?'workspaceWrite':'readOnly');
  if(mode.approval==='auto'){assert.equal(turn.approvalPolicy,'never');assert.equal(turn.sandboxPolicy.networkAccess,false);}
 }
});

test('new adapter recovers owned history but does not resurrect a killed turn as running',async t=>{
 const f=await fixture(t);const {task}=await f.call('taskCreate',{profile:'codex',cwd:f.dir,prompt:'Interrupted work'});
 f.adapter.close();f.threads.get(task.session_id.slice(6)).status={type:'notLoaded'};
 const reopened=createCodexAdapter(f.options);t.after(()=>reopened.close());
 const snapshot=await reopened.call('codexSnapshot');
 assert.equal(snapshot.sessions[0].id,task.session_id);assert.equal(snapshot.sessions[0].active,false);
 assert.equal(snapshot.tasks[0].id,task.id);assert.equal(snapshot.tasks[0].status,'failed');
 await reopened.call('taskCreate',{sessionId:task.session_id,prompt:'Continue'});
});

test('late approval cannot authorize a request from a replacement app-server',async t=>{
 let resolve;const f=await fixture(t,{approve:()=>new Promise(done=>{resolve=done})});
 const {task}=await f.call('taskCreate',{profile:'codex',cwd:f.dir,prompt:'Ask me'});
 f.child.stdout.write(JSON.stringify({id:999,method:'item/commandExecution/requestApproval',params:{threadId:task.session_id.slice(6),command:'test'}})+'\n');
 assert.equal(typeof resolve,'function');f.child.emit('exit',1);await f.call('codexStatus');resolve(true);
 await new Promise(done=>setImmediate(done));assert.equal(f.sent.some(q=>q.id===999),false);
});

test('message completion without deltas still appears and duplicate starts are rejected',async t=>{
 const f=await fixture(t);const {task}=await f.call('taskCreate',{profile:'codex',cwd:f.dir,prompt:'A short answer'});
 await assert.rejects(f.call('taskCreate',{sessionId:task.session_id,prompt:'Duplicate'}),/already working/);
 f.notify('item/completed',{threadId:task.session_id.slice(6),turnId:task.turnId,item:{id:'answer',type:'agentMessage',text:'Complete answer'}});
 assert.equal(f.events.find(e=>e.kind==='message.delta').data.text,'Complete answer');
 await assert.rejects(f.call('sessionDelete',{id:task.session_id}),/Stop/);
});

test('lists protected names as restricted and rejects reading or overwriting them',async t=>{
 const f=await fixture(t);const root=path.join(f.dir,'private-check');await fs.mkdir(root);
 const protectedNames=['.env','.env.local','.npmrc','auth.json','credentials.json','tokens.json','server.key','id_ed25519'];
 for(const name of protectedNames)await fs.writeFile(path.join(root,name),'fixture-value');
 await fs.writeFile(path.join(root,'auth.ts'),'export const signedIn = false;');
 const {task}=await f.call('taskCreate',{profile:'codex',cwd:root,prompt:'Review source'});
 const listed=(await f.call('codexFiles',{sessionId:task.session_id,path:'.'})).items;
 for(const name of protectedNames){
  assert.equal(listed.find(x=>x.name===name).restricted,true,name);
  await assert.rejects(f.call('codexFileRead',{sessionId:task.session_id,path:name}),/Private/);
  await assert.rejects(f.call('codexFileWrite',{sessionId:task.session_id,path:name,content:'replacement'}),/Private/);
  assert.equal(await fs.readFile(path.join(root,name),'utf8'),'fixture-value');
 }
 assert.equal((await f.call('codexFileRead',{sessionId:task.session_id,path:'auth.ts'})).content,'export const signedIn = false;');
 await fs.symlink(path.join(root,'.env'),path.join(root,'alias.txt'));
 await assert.rejects(f.call('codexFileRead',{sessionId:task.session_id,path:'alias.txt'}),/Private/);
});

test('task acceptance events occur only after turn acceptance and durable mapping',async t=>{
 const checks=[];let dir;
 const f=await fixture(t,{beforeResponse(q,result,child){
  if(q.method==='turn/start'){
   checks.push({phase:'before-turn-response',queued:f.events.filter(e=>e.kind==='task.queued').length});
   child.stdout.write(JSON.stringify({method:'item/agentMessage/delta',params:{threadId:q.params.threadId,turnId:result.turn.id,itemId:'early',delta:'Early text'}})+'\n');
  }
 },emit:e=>{
  if(e.kind==='task.queued'){
   const metadata=JSON.parse(require('node:fs').readFileSync(path.join(dir,'codex-sessions.json'),'utf8'));
   checks.push({phase:'accepted',saved:metadata.sessions.some(s=>s.turns.some(t=>t.id===e.taskId))});
  }
  f.events.push(e);
 }});dir=f.dir;
 const {task}=await f.call('taskCreate',{profile:'codex',cwd:f.dir,prompt:'Accept durably'});
 assert.deepEqual(checks,[{phase:'before-turn-response',queued:0},{phase:'accepted',saved:true}]);
 assert.equal(f.events.filter(e=>e.kind==='message.delta')[0].data.text,'Early text');
 const metadata=JSON.parse(await fs.readFile(path.join(f.dir,'codex-sessions.json'),'utf8'));
 assert.equal(metadata.sessions[0].turns[0].id,task.id);
});

test('rejects project associations across local and remote runtimes',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.call('taskCreate',{profile:'codex',projectId:'remote-project',cwd:f.dir,prompt:'Wrong runtime'}),/local Codex project/);
 assert.equal(f.sent.some(q=>q.method==='thread/start'),false);
 const {project}=await f.call('codexProjectCreate',{name:'Local',path:path.join(f.dir,'local')});
 const {task}=await f.call('taskCreate',{profile:'codex',projectId:project.id,prompt:'Local work'});
 await assert.rejects(f.call('sessionProject',{sessionId:task.session_id,projectId:'remote-project'}),/local Codex project/);
 let delegated=false;
 await assert.rejects(f.adapter.call('sessionProject',{sessionId:'remote-session',projectId:project.id},async()=>{delegated=true}),/same runtime/);
 await assert.rejects(f.adapter.call('taskCreate',{profile:'prime',projectId:project.id,prompt:'Wrong runtime'},async()=>{delegated=true}),/same runtime/);
 assert.equal(delegated,false);
});

test('a projectless dot path uses explicit local scratch instead of the launch folder',async t=>{
 const f=await fixture(t);const {task}=await f.call('taskCreate',{profile:'codex',cwd:'.',prompt:'Local scratch'});
 assert.equal(task.cwd,path.join(f.dir,'projects','scratch'));assert.notEqual(task.cwd,process.cwd());
});

test('an accepted turn is interrupted if its local mapping cannot be saved',async t=>{
 let dir;const f=await fixture(t,{beforeResponse(q){if(q.method==='turn/start')require('node:fs').mkdirSync(path.join(dir,'codex-sessions.json.tmp'));}});dir=f.dir;
 await assert.rejects(f.call('taskCreate',{profile:'codex',cwd:f.dir,prompt:'Do not leave untracked work'}));
 assert.equal(f.events.some(e=>e.kind==='task.queued'),false);
 assert.equal(f.sent.some(q=>q.method==='turn/interrupt'),true);
});
