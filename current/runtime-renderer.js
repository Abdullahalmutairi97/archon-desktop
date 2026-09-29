// Agent runtimes on the Archon MiniPC. Each keeps its own model choice, because
// OpenCode models (provider "opencode") cannot run under Prime or Pi and vice versa.
const ArchonRuntime=(()=>{
 const ids=['prime','pi','opencode'];
 const runtime=s=>ids.includes(s?.agentRuntime)?s.agentRuntime:'prime';
 const sessionRuntime=s=>s?.runtime==='opencode'||s?.source==='opencode'?'opencode':s?.runtime==='pi'||s?.source==='pi'||s?.source==='pi-cli'?'pi':'prime';
 const label=id=>id==='opencode'?'OpenCode':id==='pi'?'Pi':'Prime';
 const byProfile=profile=>label(profile==='opencode'||profile==='pi'?profile:'prime');
 const fits=(provider,id)=>!!provider&&(id==='opencode')===(provider==='opencode');
 const forRuntime=(rows,id)=>(rows||[]).filter(m=>fits(m.provider,id));
 const compatible=(choice,id)=>!!(choice&&choice.model&&fits(choice.provider,id));
 function modelFor(s,id){
  const current={model:s.model,provider:s.modelProvider};if(compatible(current,id))return current;
  const saved=s.runtimeModels?.[id];return compatible(saved,id)?saved:{model:null,provider:null};
 }
 function dispatch(s,session){const id=session?.id?sessionRuntime(session):runtime(s),m=modelFor(s,id);return {profile:id==='prime'?null:id,model:m.model,provider:m.provider}}
 function selection(s,id,rows){
  const previous=runtime(s),saved={...(s.runtimeModels||{}),[previous]:{model:s.model,provider:s.modelProvider}};
  const remembered=saved[id],choices=forRuntime(rows,id);
  const chosen=compatible(remembered,id)?remembered:choices.length?{model:choices[0].id,provider:choices[0].provider}:{model:'',provider:''};
  return {agentRuntime:id,activeSession:null,agent:'',model:chosen.model,modelProvider:chosen.provider,runtimeModels:saved};
 }
 const chooseModel=(s,m)=>({model:m.id,modelProvider:m.provider,runtimeModels:{...(s.runtimeModels||{}),[runtime(s)]:{model:m.id,provider:m.provider}}});
 return {ids,runtime,sessionRuntime,label,byProfile,forRuntime,modelFor,dispatch,selection,chooseModel};
})();
