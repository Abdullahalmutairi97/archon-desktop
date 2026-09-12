'use strict';

// This adapter owns only threads started by Archon. Codex owns authentication and
// durable conversation history; this file never opens its credential store.
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {spawn:spawnProcess}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const SESSION='codex:',PROJECT='codex-project:',TASK='codex-task:';
const now=()=>new Date().toISOString();
// Match the release renderer's collection normalizer before appending local rows.
// In particular, the existing server returns model choices, not a models array.
const rows=value=>{
 if(Array.isArray(value))return value;
 if(value&&typeof value==='object')for(const key of ['sessions','tasks','projects','logs','skills','jobs','backups','choices','items','terminals','messages','events','agents','cards','workspaces','work_items','runs','approvals','dependencies','artifacts']){
  if(Array.isArray(value[key]))return value[key];
 }
 return [];
};
const active=task=>!!task&&['queued','running','cancelling'].includes(task.status);
const protectedPath=value=>path.resolve(value).split(path.sep).some(part=>{
 const name=part.toLowerCase();
 return name.startsWith('.env')||['.codex','.archon','.ssh','.aws','.azure','.gnupg','.kube','.secrets','secrets','credentials','tokens',
  '.npmrc','.pypirc','.netrc','.git-credentials','auth.json','auth.toml','credentials.json','credentials.toml','tokens.json','token.json','secrets.json',
  'id_rsa','id_dsa','id_ecdsa','id_ed25519'].includes(name)||/\.(?:pem|key|p12|pfx|keystore)$/.test(name);
});

function createCodexAdapter({userDataDir,emit=()=>{},codexPath,spawn=spawnProcess,approve,requestTimeoutMs=30000}){
 if(!path.isAbsolute(userDataDir||''))throw Error('Codex data directory must be absolute.');
 const metadataPath=path.join(userDataDir,'codex-sessions.json');
 let metadata={version:1,sessions:[],projects:[]};
 try{
  const saved=JSON.parse(fs.readFileSync(metadataPath,'utf8'));
  if(saved.version!==1||!Array.isArray(saved.sessions)||!Array.isArray(saved.projects))throw Error('Invalid metadata');
  metadata=saved;
 }catch(error){if(error.code!=='ENOENT')throw Error('Could not read Archon Codex session metadata. Restore its backup before continuing.');}
 let child=null,ready=null,closed=false,requestId=0,seq=0,buffer='',persistQueue=Promise.resolve();
 const pending=new Map(),tasks=new Map(),events=new Map(),histories=new Map(),inFlight=new Map(),starting=new Set(),streamed=new Map(),earlyNotifications=new Map();
 let models=[],version='';
 const session=id=>metadata.sessions.find(s=>s.id===id);
 const owned=id=>{const result=session(id);if(!result)throw Error('Unknown Codex session.');return result;};
 const save=()=>{
  const text=JSON.stringify(metadata,null,2)+'\n';
  const write=async()=>{
   await fsp.mkdir(userDataDir,{recursive:true,mode:0o700});
   const temporary=metadataPath+'.tmp';
   const handle=await fsp.open(temporary,'w',0o600);
   try{await handle.writeFile(text);await handle.sync();}finally{await handle.close();}
   await fsp.rename(temporary,metadataPath);
   const directory=await fsp.open(userDataDir,'r');try{await directory.sync();}finally{await directory.close();}
  };
  const next=persistQueue.then(write,write);persistQueue=next;return next;
 };
 const send=message=>{
  if(!child||child.stdin.destroyed)throw Error('Codex is not running.');
  child.stdin.write(JSON.stringify(message)+'\n');
 };
 const event=(kind,task,data={})=>{
  if(task?.accepted===false)return;
  const value={seq:++seq,t:now(),kind,detail:String(data.text||data.status||''),taskId:task?.id,
   data:{...data,...(task?{session_id:task.session_id,task_id:task.id}:{})}};
  if(task){const list=events.get(task.id)||[];list.push(value);events.set(task.id,list.slice(-2000));}
  emit(value);
 };
 const rawRequest=(method,params={})=>new Promise((resolve,reject)=>{
  const id=++requestId;
  const timer=setTimeout(()=>{pending.delete(id);reject(Error('Codex did not respond in time. Try again.'));},requestTimeoutMs);
  pending.set(id,{resolve,reject,timer});
  try{send({id,method,params});}catch(error){clearTimeout(timer);pending.delete(id);reject(error);}
 });
 function disconnected(process){
  if(child!==process)return;
  child=null;ready=null;buffer='';
  for(const request of pending.values()){clearTimeout(request.timer);request.reject(Error('Codex connection closed. Reopen the session to continue.'));}pending.clear();
  for(const task of tasks.values())if(active(task)){
   task.status='failed';task.error='Codex disconnected. Reopen the session to recover its saved history.';task.completed_at=now();
   event('task.failed',task,{text:task.error});
  }
  inFlight.clear();
 }
 async function approval(request){
  const process=child;
  const p=request.params||{},s=session(SESSION+p.threadId),task=s&&inFlight.get(s.id);
  const command=request.method==='item/commandExecution/requestApproval';
  const file=request.method==='item/fileChange/requestApproval';
  if(command||file){
   let accepted=false;
   try{accepted=!!s&&active(task)&&!!approve&&await approve({kind:command?'command':'file',command:command?String(p.command||''):undefined,cwd:String(p.cwd||s.cwd),reason:String(p.reason||''),paths:file?[String(p.grantRoot||s.cwd)]:undefined});}catch{}
   if(child===process)send({id:request.id,result:{decision:accepted&&active(task)?'accept':'decline'}});
   if(!accepted&&task)event('diagnostic',task,{text:'Codex approval was declined. The requested action was not authorized.'});
  }else{
   if(child===process)send({id:request.id,error:{code:-32601,message:'This interaction is not supported by Archon Desktop.'}});
   if(task)event('diagnostic',task,{text:'Codex requested an unsupported interaction. Continue in the Codex CLI if this task needs it.'});
  }
 }
 function notification(method,p){
  const s=session(SESSION+p.threadId);if(!s)return;
  const task=inFlight.get(s.id);if(!task)return;
  if(task.accepted===false){const queue=earlyNotifications.get(task.id)||[];queue.push([method,p]);earlyNotifications.set(task.id,queue);return;}
  if(p.turnId&&task.turnId&&p.turnId!==task.turnId)return;
  if(method==='item/agentMessage/delta'){
   const key=`${s.id}:${p.itemId}`;streamed.set(key,(streamed.get(key)||'')+String(p.delta||''));
   event('message.delta',task,{message_id:`${s.id}:${p.itemId}`,text:String(p.delta||'')});
  }else if(method==='item/started'&&['commandExecution','fileChange','mcpToolCall'].includes(p.item?.type)){
   const item=p.item;
   event('tool',task,{text:item.type==='commandExecution'?String(item.command||''):item.type==='fileChange'?`Files: ${(item.changes||[]).map(c=>c.path).join(', ')}`:`${item.server||''}/${item.tool||''}`,tool:item.type});
  }else if(method==='item/commandExecution/outputDelta'){
   event('output',task,{text:String(p.delta||'')});
  }else if(method==='item/completed'&&p.item?.type==='agentMessage'){
   task.result={text:String(p.item.text||'')};
   const key=`${s.id}:${p.item.id}`,previous=streamed.get(key)||'';
   if(task.result.text.startsWith(previous)&&task.result.text.length>previous.length)event('message.delta',task,{message_id:key,text:task.result.text.slice(previous.length)});
   streamed.delete(key);
   event('message.done',task,{message_id:`${s.id}:${p.item.id}`});
  }else if(method==='turn/completed'){
   if(task.turnId&&p.turn.id!==task.turnId)return;
   task.turnId=p.turn.id;
   const status=p.turn.status==='interrupted'?'cancelled':p.turn.status==='failed'?'failed':'completed';
   task.status=status;task.error=p.turn.error?.message||'';task.completed_at=now();task.updated_at=now();
   s.updatedAt=now();inFlight.delete(s.id);histories.delete(s.id);
   event('message.done',task,{});event(`task.${status}`,task,{text:task.error||task.result?.text||status});
   save().catch(()=>event('diagnostic',task,{text:'Could not save Archon session metadata. Codex still retains the conversation.'}));
  }else if(method==='error'){
   event('diagnostic',task,{text:String(p.error?.message||'Codex reported an error.')});
  }
 }
 function receive(message){
  if(message.method){
   if(message.id!==undefined)void approval(message).catch(()=>{});
   else notification(message.method,message.params||{});
  }else if(message.id!==undefined){
   const request=pending.get(message.id);if(!request)return;
   clearTimeout(request.timer);pending.delete(message.id);
   if(message.error)request.reject(Error(String(message.error.message||'Codex request failed.')));else request.resolve(message.result);
  }
 }
 async function start(){
  if(closed)throw Error('Codex adapter is closed.');
  if(ready)return ready;
  ready=(async()=>{
   const local=path.join(os.homedir(),'.local','bin','codex');
   const process=spawn(codexPath||(fs.existsSync(local)?local:'codex'),['app-server'],{stdio:['pipe','pipe','pipe'],windowsHide:true});
   child=process;
   process.stdout.setEncoding('utf8');
   process.stdout.on('data',chunk=>{
    buffer+=chunk;
    if(buffer.length>16*1024*1024){process.kill();disconnected(process);return;}
    let index;
    while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);try{receive(JSON.parse(line));}catch{}}
   });
   // Drain diagnostics without logging protocol contents or credential values.
   process.stderr.on('data',()=>{});process.on('error',()=>disconnected(process));process.on('exit',()=>disconnected(process));
   const initialized=await rawRequest('initialize',{clientInfo:{name:'archon_desktop',title:'Archon Desktop',version:'0.3.0'},capabilities:{experimentalApi:false}});
   version=String(initialized.userAgent||'');send({method:'initialized',params:{}});
  })();
  try{await ready;}catch(error){const process=child;child=null;ready=null;process?.kill();throw error;}
 }
 const request=async(method,params)=>{await start();return rawRequest(method,params);};
 async function status(){
  try{const account=await request('account/read',{refreshToken:false});return {available:true,authenticated:!!account.account||account.requiresOpenaiAuth===false,version};}
  catch{return {available:false,authenticated:false,error:'Codex CLI is unavailable. Install Codex on this computer and sign in with codex login.'};}
 }
 async function listModels(){
  const found=[];let cursor;
  do{const result=await request('model/list',{limit:100,includeHidden:false,...(cursor?{cursor}:{})});
   found.push(...result.data.filter(m=>!m.hidden).map(m=>({model:m.model,provider:'codex',display_name:m.displayName,isDefault:m.isDefault,reasoning_efforts:m.supportedReasoningEfforts||[]})));cursor=result.nextCursor;
  }while(cursor&&found.length<1000);
  models=found;return {models};
 }
 function taskFromTurn(s,turn,threadStatus){
  let mapping=(s.turns||[]).find(t=>t.turnId===turn.id);
  if(!mapping){const startingTask=inFlight.get(s.id);mapping={id:startingTask&&!startingTask.turnId?startingTask.id:TASK+randomUUID(),turnId:turn.id};(s.turns||=[]).push(mapping);}
  const previous=tasks.get(mapping.id),user=(turn.items||[]).find(i=>i.type==='userMessage');
  const answer=(turn.items||[]).filter(i=>i.type==='agentMessage').at(-1);
  const interrupted=turn.status==='inProgress'&&threadStatus==='notLoaded'&&!active(previous);
  const task=Object.assign(previous||{},{id:mapping.id,turnId:turn.id,session_id:s.id,cwd:s.cwd,model:s.model,provider:'codex',
   status:interrupted?'failed':turn.status==='inProgress'?'running':turn.status==='interrupted'?'cancelled':turn.status==='failed'?'failed':'completed',
   prompt:user?.content?.filter(i=>i.type==='text').map(i=>i.text).join('\n')||previous?.prompt||'',
   started_at:turn.startedAt?new Date(turn.startedAt*1000).toISOString():previous?.started_at||s.createdAt,
   completed_at:turn.completedAt?new Date(turn.completedAt*1000).toISOString():previous?.completed_at||null,
   approval_mode:s.approval||'ask',chat_only:s.chatOnly||false,error:interrupted?'Codex stopped before this turn completed. Send a follow-up to continue.':turn.error?.message||'',result:answer?{text:answer.text}:previous?.result||null});
  tasks.set(task.id,task);if(active(task))inFlight.set(s.id,task);return task;
 }
 async function history(s){
  const result=await request('thread/read',{threadId:s.threadId,includeTurns:true});
  const thread=result.thread;histories.set(s.id,thread);
  for(const turn of thread.turns||[])taskFromTurn(s,turn,thread.status?.type);
  s.updatedAt=thread.updatedAt?new Date(thread.updatedAt*1000).toISOString():s.updatedAt;
  await save();return thread;
 }
 const sessionRows=()=>metadata.sessions.map(s=>({id:s.id,title:s.title,project_id:s.projectId||null,model:s.model,source:'codex',cwd:s.cwd,
  message_count:(histories.get(s.id)?.turns||[]).reduce((n,t)=>n+(t.items||[]).filter(i=>['userMessage','agentMessage'].includes(i.type)).length,0),
  active:active(inFlight.get(s.id)),preview:histories.get(s.id)?.preview||'',last_active:s.updatedAt,started_at:s.createdAt}));
 async function snapshot(refresh=true){
  if(refresh)await Promise.all(metadata.sessions.map(s=>history(s).catch(()=>{})));
  return {projects:metadata.projects,sessions:sessionRows(),tasks:[...tasks.values()].filter(t=>t.accepted!==false),models};
 }
 async function canonicalRoot(input,create=false){
  if(typeof input!=='string'||!path.isAbsolute(input))throw Error('Choose an absolute local project folder.');
  if(create)await fsp.mkdir(input,{recursive:true});
  const root=await fsp.realpath(input);if(!(await fsp.stat(root)).isDirectory())throw Error('The project folder is not a directory.');
  return root;
 }
 async function createProject(p){
  if(!String(p.name||'').trim())throw Error('Enter a project name.');
  const root=await canonicalRoot(p.path||path.join(userDataDir,'projects',randomUUID()),true);
  const project={id:PROJECT+randomUUID(),name:String(p.name).trim(),primary_path:root,description:String(p.description||''),runtime:'codex'};
  metadata.projects.push(project);await save();return {project};
 }
 async function createTask(p){
  const prompt=String(p.prompt||'').trim();if(!prompt)throw Error('Enter a prompt.');
  if(p.projectId&&!String(p.projectId).startsWith(PROJECT))throw Error('Choose a local Codex project for a Codex session.');
  let s=p.sessionId?owned(p.sessionId):null;
  const key=s?.id||`new:${p.projectId||p.cwd||''}`;
  if(starting.has(key)||s&&active(inFlight.get(s.id)))throw Error('Codex is already working in this session. Stop it or wait for it to finish.');
  starting.add(key);
  let task;
  try{
   const auth=await status();if(!auth.available||!auth.authenticated)throw Error('Sign in to Codex on this computer with codex login before starting a session.');
   const project=p.projectId?metadata.projects.find(x=>x.id===p.projectId):null;
   if(p.projectId?.startsWith(PROJECT)&&!project)throw Error('Unknown Codex project.');
   const requestedCwd=p.cwd&&p.cwd!=='.'?p.cwd:null;
   const cwd=await canonicalRoot(s?.cwd||project?.primary_path||requestedCwd||path.join(userDataDir,'projects','scratch'),!s&&!project&&!requestedCwd);
   const mode=p.approval||s?.approval||'ask';
   const readOnly=mode==='plan'||p.chatOnly===true;
   const policy={sandbox:readOnly?'read-only':'workspace-write',approvalPolicy:mode==='auto'?'never':'on-request',approvalsReviewer:'user'};
   const config={cwd,...policy,...(p.model?{model:p.model}:{})};
   if(!s){
    const response=await request('thread/start',config);
    s={id:SESSION+response.thread.id,threadId:response.thread.id,title:prompt.split('\n')[0].slice(0,100),projectId:p.projectId||null,cwd,model:response.model||p.model||'',createdAt:now(),updatedAt:now(),turns:[]};
    metadata.sessions.push(s);await save();
   }else await request('thread/resume',{threadId:s.threadId,...config});
   s.approval=mode;s.chatOnly=p.chatOnly===true;if(p.model)s.model=p.model;
   task={id:TASK+randomUUID(),session_id:s.id,status:'queued',accepted:false,prompt,cwd,model:s.model,provider:'codex',approval_mode:mode,chat_only:s.chatOnly,started_at:now(),updated_at:now(),result:null};
   tasks.set(task.id,task);inFlight.set(s.id,task);
   const response=await request('turn/start',{threadId:s.threadId,input:[{type:'text',text:prompt}],approvalPolicy:policy.approvalPolicy,approvalsReviewer:'user',
    sandboxPolicy:readOnly?{type:'readOnly'}:{type:'workspaceWrite',writableRoots:[cwd],networkAccess:false,excludeSlashTmp:true,excludeTmpdirEnvVar:true},...(p.model?{model:p.model}:{}),...(p.reasoningEffort?{effort:p.reasoningEffort}:{})});
   task.turnId=response.turn.id;if(!(s.turns||=[]).some(t=>t.turnId===task.turnId))s.turns.push({id:task.id,turnId:task.turnId});
   await save();delete task.accepted;
   event('task.queued',task,{text:prompt});event('session',task,{});
   if(task.status==='queued'){task.status='running';event('task.started',task,{text:'Codex is working'});}
   const queued=earlyNotifications.get(task.id)||[];earlyNotifications.delete(task.id);
   for(const [method,params]of queued)notification(method,params);
   return {task:{...task},session_id:s.id};
  }catch(error){
   if(task){
    if(task.turnId&&task.accepted===false)try{await request('turn/interrupt',{threadId:s.threadId,turnId:task.turnId});}catch{const process=child;process?.kill();if(process)disconnected(process);}
    task.status='failed';task.error=error.message;task.completed_at=now();inFlight.delete(task.session_id);earlyNotifications.delete(task.id);event('task.failed',task,{text:error.message});
   }
   throw error;
  }finally{starting.delete(key);}
 }
 async function messages(s){
  const thread=await history(s),result=[];
  for(const turn of thread.turns||[])for(const item of turn.items||[]){
   const base={id:`${s.id}:${item.id}`,timestamp:turn.startedAt||Date.parse(s.createdAt)/1000};
   if(item.type==='userMessage')result.push({...base,role:'user',content:item.content.filter(i=>i.type==='text').map(i=>i.text).join('\n')});
   else if(item.type==='agentMessage')result.push({...base,role:'assistant',content:item.text});
   else if(item.type==='commandExecution')result.push({...base,role:'assistant',kind:'tool',content:`${item.command}\n${item.aggregatedOutput||''}`});
   else if(item.type==='fileChange')result.push({...base,role:'assistant',kind:'tool',content:(item.changes||[]).map(c=>`${c.path}\n${c.diff||''}`).join('\n')});
  }
  return result;
 }
 async function localPath(s,input,writing=false){
  const root=await fsp.realpath(s.cwd),target=path.resolve(root,input||'.');
  const within=value=>value===root||value.startsWith(root+path.sep);
  if(!within(target))throw Error('File is outside this Codex project.');
  if(protectedPath(target))throw Error('Private application and credential files cannot be opened here.');
  let real;
  try{real=await fsp.realpath(target);}catch(error){if(!writing||error.code!=='ENOENT')throw error;real=path.join(await fsp.realpath(path.dirname(target)),path.basename(target));}
  if(!within(real))throw Error('File is outside this Codex project.');
  if(protectedPath(real))throw Error('Private application and credential files cannot be opened here.');
  return real;
 }
 async function fileCall(op,p){
  const s=owned(p.sessionId),file=await localPath(s,p.path,op==='codexFileWrite');
  if(op==='codexFiles'){
   const entries=await fsp.readdir(file,{withFileTypes:true});
   return {path:file,items:await Promise.all(entries.map(async e=>{
    const full=path.join(file,e.name),restricted=protectedPath(full)||e.isSymbolicLink();
    const stat=restricted?null:await fsp.stat(full);
    return {name:e.name,path:full,type:e.isDirectory()?'directory':'file',is_dir:e.isDirectory(),is_symlink:e.isSymbolicLink(),restricted,mime:'',size:stat?.size||0,modified_at:stat?.mtime.toISOString()||''};
   }))};
  }
  if(op==='codexFileWrite'){
   if(typeof p.content!=='string'||Buffer.byteLength(p.content)>2*1024*1024)throw Error('File content exceeds the editor limit.');
   await fsp.writeFile(file,p.content,'utf8');return {ok:true,path:file};
  }
  const stat=await fsp.stat(file);if(!stat.isFile())throw Error('Choose a file.');
  const maximum=Math.min(Number(p.maxBytes)||512*1024,2*1024*1024),handle=await fsp.open(file,'r');
  try{const bytes=Buffer.alloc(Math.min(stat.size,maximum));const {bytesRead}=await handle.read(bytes,0,bytes.length,0);const content=bytes.subarray(0,bytesRead);return {path:file,content:content.toString('utf8'),size:stat.size,truncated:stat.size>bytesRead,binary:content.includes(0)};}finally{await handle.close();}
 }
 async function merged(op,p,remoteCall,local){
  try{return [...rows(await remoteCall(op,p)),...local];}catch(error){if(local.length)return local;throw error;}
 }
 async function call(op,p={},remoteCall=async()=>{throw Error('Remote backend is unavailable.');}){
  if(op==='codexStatus')return status();
  if(op==='codexModels')return listModels();
  if(op==='codexSnapshot'){try{await listModels();}catch{}return snapshot();}
  if(op==='codexProjectCreate'||op==='projectCreate'&&p.runtime==='codex')return createProject(p);
  if(['codexFiles','codexFileRead','codexFileWrite'].includes(op))return fileCall(op,p);
  if(op==='taskCreate'&&(p.profile==='codex'||p.sessionId?.startsWith(SESSION)))return createTask(p);
  if(op==='taskCreate'&&p.projectId?.startsWith(PROJECT))throw Error('A session and project must use the same runtime.');
  if(op==='projects')return merged(op,p,remoteCall,metadata.projects);
  if(op==='sessions'){const local=await snapshot();return merged(op,p,remoteCall,local.sessions.filter(s=>!p.projectId||s.project_id===p.projectId));}
  if(op==='tasks'){const local=await snapshot();return merged(op,p,remoteCall,local.tasks);}
  if(op==='agents')return merged(op,p,remoteCall,[{id:'codex',name:'codex',display_name:'Codex',provider:'codex',model:models.find(m=>m.isDefault)?.model||'',description:'Codex on this computer',enabled:true,capabilities:['local files','code','terminal'],role:'coding'}]);
  if(op==='models'){try{await listModels();}catch{}return merged(op,p,remoteCall,models);}
  if(op==='messages'&&p.sessionId?.startsWith(SESSION))return messages(owned(p.sessionId));
  if(op==='sessionProject'&&p.sessionId?.startsWith(SESSION)){
   const s=owned(p.sessionId);
   if(p.projectId&&!String(p.projectId).startsWith(PROJECT))throw Error('Choose a local Codex project for a Codex session.');
   if(p.projectId&&!metadata.projects.some(x=>x.id===p.projectId))throw Error('Unknown Codex project.');
   s.projectId=p.projectId||null;await save();return {ok:true};
  }
  if(op==='sessionProject'&&p.projectId?.startsWith(PROJECT))throw Error('A session and project must use the same runtime.');
  if(op==='sessionRename'&&(p.id||p.sessionId)?.startsWith(SESSION)){
   const s=owned(p.id||p.sessionId),title=String(p.title||p.name||'').trim();if(!title)throw Error('Enter a session title.');
   await request('thread/name/set',{threadId:s.threadId,name:title});s.title=title;await save();return {ok:true};
  }
  if(op==='sessionDelete'&&p.id?.startsWith(SESSION)){
   const s=owned(p.id);if(active(inFlight.get(s.id)))throw Error('Stop this Codex session before deleting it.');
   await request('thread/archive',{threadId:s.threadId});metadata.sessions=metadata.sessions.filter(x=>x!==s);histories.delete(s.id);
   for(const [id,task]of tasks)if(task.session_id===s.id){tasks.delete(id);events.delete(id);}await save();return {ok:true};
  }
  if(op==='projectDelete'&&p.projectId?.startsWith(PROJECT)){
   if(metadata.sessions.some(s=>s.projectId===p.projectId&&active(inFlight.get(s.id))))throw Error('Stop active Codex sessions before removing this project.');
   metadata.projects=metadata.projects.filter(x=>x.id!==p.projectId);for(const s of metadata.sessions)if(s.projectId===p.projectId)s.projectId=null;
   await save();return {ok:true};
  }
  if(['task','taskCancel','taskEvents'].includes(op)&&p.id?.startsWith(TASK)){
   let task=tasks.get(p.id);if(!task){await snapshot();task=tasks.get(p.id);}if(!task||task.accepted===false)throw Error('Unknown Codex task.');
   if(op==='task')return {task};
   if(op==='taskEvents')return (events.get(task.id)||[]).filter(e=>e.seq>(p.after||0)).map(e=>({seq:e.seq,type:e.kind,created_at:e.t,task_id:e.taskId,data:e.data}));
   if(!active(task))return {ok:true};
   if(!task.turnId)throw Error('Codex is still starting. Try Stop again in a moment.');
   await request('turn/interrupt',{threadId:owned(task.session_id).threadId,turnId:task.turnId});
   if(active(task)){task.status='cancelling';event('task.cancelling',task,{text:'Stopping Codex…'});}return {ok:true};
  }
  return remoteCall(op,p);
 }
 function close(){closed=true;const process=child;process?.kill();if(process)disconnected(process);}
 return {call,close};
}

module.exports={createCodexAdapter};
