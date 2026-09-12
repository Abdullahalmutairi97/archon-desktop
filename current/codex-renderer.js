// Desktop-owned Codex state. The server connection remains independent.
const ArchonCodex=(()=>{
 const localSession=id=>String(id||'').startsWith('codex:');
 const localProject=id=>String(id||'').startsWith('codex-project:');
 const runtime=s=>s?.agentRuntime==='codex'||localProject(s?.activeProject)?'codex':s?.agentRuntime==='pi'?'pi':'prime';
 const sessionRuntime=s=>s?.runtime==='codex'||localSession(s?.id)?'codex':s?.runtime==='pi'||s?.source==='pi'||s?.source==='pi-cli'?'pi':'prime';
 const activeRuntime=(s,ui,data)=>{const id=ui?.sessionId||ui?.chatId;return id?sessionRuntime((data?.sessions||[]).find(session=>session.id===id)||{id}):runtime(s)};
 const sessionAccessible=(connected,session)=>connected||localSession(session?.id);
 const label=id=>id==='codex'?'Codex':id==='pi'?'Pi':'Prime';
 const models=(rows,id)=>(rows||[]).filter(m=>!!m.provider&&(id==='codex'?m.provider==='codex':m.provider!=='codex'));
 const compatible=(choice,id)=>choice&&choice.model&&(id==='codex'?choice.provider==='codex':choice.provider&&choice.provider!=='codex');
 function modelFor(s,id){
  const current={model:s.model,provider:s.modelProvider};
  if(compatible(current,id))return current;
  const saved=s.runtimeModels?.[id];return compatible(saved,id)?saved:{model:null,provider:id==='codex'?'codex':null};
 }
 function selection(s,id,rows=[]){
  const previous=runtime(s),saved={...(s.runtimeModels||{}),[previous]:{model:s.model,provider:s.modelProvider}};
  const choices=models(rows,id),remembered=saved[id],chosen=compatible(remembered,id)?remembered:choices.length?{model:choices[0].id,provider:choices[0].provider}:{model:'',provider:id==='codex'?'codex':''};
  const cwds={...(s.runtimeCwds||{}),[previous]:s.defaultCwd||'.'};
  const project=s.activeProject&&(localProject(s.activeProject)===(id==='codex'))?s.activeProject:null;
  return {agentRuntime:id,activeSession:null,agent:'',activeProject:project,model:chosen.model,modelProvider:chosen.provider,runtimeModels:saved,runtimeCwds:cwds,defaultCwd:cwds[id]||'.'};
 }
 function chooseModel(s,m){return {model:m.id,modelProvider:m.provider,runtimeModels:{...(s.runtimeModels||{}),[runtime(s)]:{model:m.id,provider:m.provider}}}}
 function dispatchOptions(s,session){const id=session?.id?sessionRuntime(session):runtime(s),model=modelFor(s,id);return {profile:id==='prime'?null:id,model:model.model,provider:model.provider}}
 function newPayload(prompt,cwd,s){
  const id=runtime(s),projectId=s.activeProject||null;
  if(id==='codex'&&projectId&&!localProject(projectId))throw Error('Choose a local Codex project or start without a project.');
  return {prompt,cwd,projectId,approval:s.approval,...dispatchOptions(s)};
 }
 function browserContext(s){
  if(runtime(s)!=='codex')return {};
  const projectId=s.activeProject||null;
  if(projectId&&!localProject(projectId))throw Error('Choose a local Codex project or start without a project.');
  return {projectId,cwd:projectId?null:s.defaultCwd||'.'};
 }
 function mergeLocal(previous,snapshot,names={}){
  const merge=(old,rows,owned)=>(old||[]).filter(row=>!owned(row.id)).concat(rows||[]);
  const projects=merge(previous.projects,snapshot.projects,localProject);
  const byProject=new Map(projects.map(p=>[p.id,p]));
  const sessions=merge(previous.sessions,snapshot.sessions,localSession).map(s=>({...s,title:names[s.id]||s.title,project:s.projectId?byProject.get(s.projectId)?.name||'—':'—'}));
  const bySession=new Map(sessions.map(s=>[s.id,s]));
  const tasks=merge(previous.tasks,snapshot.tasks,id=>String(id).startsWith('codex-task:')).map(t=>({...t,sessionTitle:bySession.get(t.sessionId)?.title||'—'}));
  const localChats=sessions.filter(s=>localSession(s.id)&&tasks.some(t=>t.sessionId===s.id&&t.chatOnly)).map(s=>({id:s.id,title:s.title,preview:s.preview,msgs:s.msgs,updatedAt:s.updatedAt}));
  return {...previous,projects:projects.map(p=>{const rows=sessions.filter(s=>s.projectId===p.id);return {...p,sessions:rows.length,running:tasks.filter(t=>bySession.get(t.sessionId)?.projectId===p.id&&['working','queued'].includes(t.state)).length,lastActivity:rows.reduce((last,s)=>!last||s.updatedAt>last?s.updatedAt:last,null)}}),sessions,tasks,chats:merge(previous.chats,localChats,localSession),models:(previous.models||[]).filter(m=>m.provider!=='codex').concat(snapshot.models||[])};
 }
 async function snapshot(){
  const data=await window.archon.api.call('codexSnapshot');
  return {projects:(data.projects||[]).map(ip),sessions:(data.sessions||[]).map(Xg),tasks:(data.tasks||[]).filter(t=>t.status!=='cancelled').map(bl),models:(data.models||[]).map(sm)};
 }
 let state={loading:true,available:false,authenticated:false};const listeners=new Set();let checking=null;
 const subscribe=fn=>{listeners.add(fn);return()=>listeners.delete(fn)};
 async function check(){
  if(checking)return checking;
  checking=(async()=>{let next;try{const value=await window.archon.api.call('codexStatus');next={loading:false,available:value.available===true,authenticated:value.authenticated===true,version:String(value.version||'')}}catch{next={loading:false,available:false,authenticated:false}};
   const changed=JSON.stringify(next)!==JSON.stringify(state);state=next;if(changed)for(const fn of listeners)fn();return changed;
  })();try{return await checking}finally{checking=null}
 }
 const useStatus=()=>k.useSyncExternalStore(subscribe,()=>state);
 return {localSession,localProject,runtime,sessionRuntime,activeRuntime,sessionAccessible,label,models,selection,chooseModel,dispatchOptions,newPayload,browserContext,mergeLocal,snapshot,check,useStatus};
})();
function ArchonCodexBridge(){
 const {refresh}=Ne();
 k.useEffect(()=>{let live=true;const check=async()=>{if(await ArchonCodex.check()&&live)void refresh()};void check();const timer=window.setInterval(check,15000);return()=>{live=false;window.clearInterval(timer)}},[refresh]);
 return null;
}
function ArchonCodexNotice(){
 const status=ArchonCodex.useStatus();
 const text=status.loading?'Checking Codex on this PC…':!status.available?'Install the Codex CLI on this PC, then retry.':!status.authenticated?'Sign in to the Codex CLI on this PC, then retry.':'Codex is ready on this PC. Projects and files stay on this PC.';
 return ASn('div',{className:'as-notice',role:'status'},ASicon('ph-terminal-window'),ASn('p',null,text),ASn('button',{type:'button',className:'as-button as-secondary',onClick:()=>void ArchonCodex.check()},'Retry'));
}
