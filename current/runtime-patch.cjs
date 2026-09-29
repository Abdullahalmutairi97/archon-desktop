// Adds OpenCode beside Prime and Pi wherever the v0.3.0 renderer hard-codes its two agents.
function patchRuntimes(original){
 let source=original;
 const once=(before,after,label)=>{if(source.split(before).length!==2)throw Error(`Runtime ${label} target must occur exactly once`);source=source.replace(before,()=>after)};
 const block=(start,end,change,label)=>{const a=source.indexOf(start),b=source.indexOf(end,a+start.length);if(a<0||b<0||source.indexOf(start,a+1)>=0)throw Error(`Runtime ${label} boundary missing`);source=source.slice(0,a)+change(source.slice(a,b))+source.slice(b)};
 const change=(text,before,after,label)=>{if(text.split(before).length!==2)throw Error(`Runtime ${label} target must occur exactly once`);return text.replace(before,()=>after)};

 once('model:o.model,provider:o.modelProvider,approval:o.approval,profile:o.agentRuntime==="pi"?"pi":null}}','approval:o.approval,...ArchonRuntime.dispatch(o)}}','new-session dispatch');
 once('profile:s.agentRuntime==="pi"?"pi":null','...ArchonRuntime.dispatch(s)','browser dispatch');
 once('profile:d.agentRuntime==="pi"?"pi":null','...ArchonRuntime.dispatch(d)','chat dispatch');
 once('profile:n.agentRuntime==="pi"?"pi":null','...ArchonRuntime.dispatch(n,E)','reply dispatch');
 const activity='agentName:(_?.profile==="pi"?"Pi":"Prime")';
 if(source.split(activity).length!==3)throw Error('Runtime activity label anchors changed');
 source=source.split(activity).join('agentName:ArchonRuntime.byProfile(_?.profile)');

 block('function wy(){','function by(){',()=>"function wy(){return ASn(ASModels)}\n",'legacy model component');
 block('function ASModels(){','function ASConnection(){',text=>{
  text=change(text,"const runtime=s.agentRuntime==='pi'?'pi':'prime';","const runtime=ArchonRuntime.runtime(s);",'models runtime');
  text=change(text,'const catalog=data.models.filter(m=>!m.hidden);','const catalog=ArchonRuntime.forRuntime(data.models,runtime).filter(m=>!m.hidden);','runtime models');
  text=change(text,"note:'Both run on your MiniPC. Existing conversations keep their original agent.'","note:'All run on your MiniPC. Existing conversations keep their original agent.'",'agent note');
  text=change(text,"['pi','Pi','ph-terminal-window','Your Pi coding agent runtime.']","['pi','Pi','ph-terminal-window','Your Pi coding agent runtime.'],['opencode','OpenCode','ph-code','The OpenCode CLI and its models.']",'OpenCode card');
  text=change(text,"onClick:()=>patch({agentRuntime:id,activeSession:null,agent:''})","onClick:()=>patch(ArchonRuntime.selection(s,id,data.models))",'agent selection');
  text=change(text,'onClick:()=>patch({model:m.id,modelProvider:m.provider})','onClick:()=>patch(ArchonRuntime.chooseModel(s,m))','remember model');
  return text;
 },'models component');
 block('function zy(){','const Tl=',()=>'function zy(){const{settings,patch,go,data}=Ne();return r.jsxs(Kt,{children:[r.jsx(pn,{title:"MiniPC agents",subtitle:"Remote coding agents on the Archon MiniPC. Conversations keep their original agent."}),r.jsx(ei,{children:ArchonRuntime.ids.map(id=>r.jsxs("div",{style:{padding:18,border:"1px solid var(--ar-edge)",borderRadius:8,marginBottom:12},children:[r.jsx("h3",{children:ArchonRuntime.label(id)}),r.jsx("p",{children:"Runs on the Archon MiniPC, not this computer."}),r.jsx("button",{type:"button",className:"btn btn-primary",onClick:()=>{patch(ArchonRuntime.selection(settings,id,data.models));go("new")},children:"New "+ArchonRuntime.label(id)+" session"})]},id))})]})}\n','agent page');

 once("function SSagent(s){return s.runtime==='pi'||s.source==='pi'||s.source==='pi-cli'?'pi':'prime'}",'function SSagent(s){return ArchonRuntime.sessionRuntime(s)}','session runtime');
 once("ASicon(agent==='pi'?'ph-terminal-window':'ph-lightning'),agent==='pi'?'Pi':'Prime'","ASicon(agent==='opencode'?'ph-code':agent==='pi'?'ph-terminal-window':'ph-lightning'),ArchonRuntime.label(agent)",'session badge');
 once("SSagent($)==='pi'?'Pi':'Prime'",'ArchonRuntime.label(SSagent($))','session list label');
 once("[['all','All'],['prime','Prime'],['pi','Pi']]","[['all','All'],['prime','Prime'],['pi','Pi'],['opencode','OpenCode']]",'session filter');
 once('p.runtime==="pi"?"Pi":"Prime"','ArchonRuntime.label(ArchonRuntime.sessionRuntime(p))','titlebar session agent');
 const labelPattern=/([ns])\.agentRuntime===("|')pi\2\?("|')Pi\3:("|')Prime\4/g;
 if([...source.matchAll(labelPattern)].length!==3)throw Error('Runtime label anchors changed');
 source=source.replace(labelPattern,(_,id)=>`ArchonRuntime.label(ArchonRuntime.runtime(${id}))`);
 once("runtime ${s.agentRuntime==='pi'?'pi':'prime'}","runtime ${ArchonRuntime.runtime(s)}",'diagnostic runtime');
 once('n.agentRuntime==="pi"?"Start a Pi session','ArchonRuntime.runtime(n)==="opencode"?"Start an OpenCode session on the Archon MiniPC. OpenCode works in your project with the model you pick for it.":n.agentRuntime==="pi"?"Start a Pi session','new-session description');
 once('n.agentRuntime==="pi"?"Next prompt opens a new Pi session on the MiniPC"','ArchonRuntime.runtime(n)==="opencode"?"Next prompt opens a new OpenCode session on the MiniPC":n.agentRuntime==="pi"?"Next prompt opens a new Pi session on the MiniPC"','new-session hint');
 once("'A desktop for both agents'","'A desktop for your agents'",'general heading');
 once("Prime and Pi work on the Archon MiniPC","Prime, Pi and OpenCode work on the Archon MiniPC",'general description');
 once("'Prime / Pi'","'Prime / Pi / OpenCode'",'about runtimes');
 once('const Se=f.models.filter(q=>!!q.provider);','const Se=ArchonRuntime.forRuntime(f.models,ArchonRuntime.runtime(s));','automatic model selection');
 once('[x,f.models,s.model,s.modelProvider,$]','[x,f.models,s.model,s.modelProvider,s.agentRuntime,$]','model effect dependencies');
 return source;
}
module.exports={patchRuntimes};
