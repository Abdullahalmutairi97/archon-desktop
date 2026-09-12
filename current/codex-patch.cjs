const fs=require('node:fs');
const path=require('node:path');

function patchCodexRenderer(original){
 let source=original;
 const once=(before,after,label)=>{if(source.split(before).length!==2)throw Error(`Codex ${label} target must occur exactly once`);source=source.replace(before,()=>after)};
 const block=(start,end,change,label)=>{const a=source.indexOf(start),b=source.indexOf(end,a+start.length);if(a<0||b<0||source.indexOf(start,a+1)>=0)throw Error(`Codex ${label} boundary missing`);const text=source.slice(a,b);source=source.slice(0,a)+change(text)+source.slice(b)};
 const change=(text,before,after,label)=>{if(text.split(before).length!==2)throw Error(`Codex ${label} target must occur exactly once`);return text.replace(before,()=>after)};

 once('function d1(n,s,o){return{prompt:n,cwd:s,projectId:o.activeProject??null,model:o.model,provider:o.modelProvider,approval:o.approval,profile:o.agentRuntime==="pi"?"pi":null}}','function d1(n,s,o){return ArchonCodex.newPayload(n,s,o)}','new-session dispatch');
 once('profile:s.agentRuntime==="pi"?"pi":null','...ArchonCodex.dispatchOptions(s),...ArchonCodex.browserContext(s)','browser dispatch');
 once('profile:d.agentRuntime==="pi"?"pi":null','...ArchonCodex.dispatchOptions(d)','chat dispatch');
 once('profile:n.agentRuntime==="pi"?"pi":null','...ArchonCodex.dispatchOptions(n,E)','reply ownership');
 once('if(!I)return;if(!y){F(qp);return}','if(!I)return;if(!ArchonCodex.sessionAccessible(y,I)){F(qp);return}','offline local transcript');
 once('k.useEffect(()=>{if(!y||m)return;let T=!1;const ie=Ee.filter','k.useEffect(()=>{if(!ArchonCodex.sessionAccessible(y,E)||m)return;let T=!1;const ie=Ee.filter','offline local activity');
 once('running:!1,agentName:(_?.profile==="pi"?"Pi":"Prime")','running:!1,agentName:ArchonCodex.label(ArchonCodex.sessionRuntime(E))','past activity agent name');
 once('running:!!Y,agentName:(_?.profile==="pi"?"Pi":"Prime")','running:!!Y,agentName:ArchonCodex.label(ArchonCodex.sessionRuntime(E))','live activity agent name');
 once('j,!m&&!y&&n.approval==="plan"','j,!m&&!ArchonCodex.sessionAccessible(y,E)&&n.approval==="plan"','offline example boundary');
 once('K.createProject({name:F,path:O.trim()||null})','K.createProject({name:F,path:O.trim()||null,runtime:ArchonCodex.runtime(s)})','local project creation');
 once('children:"Folder · optional"','children:ArchonCodex.runtime(s)==="codex"?"Folder on this PC · optional":"Folder on MiniPC · optional"','project location');
 once('placeholder:"Defaults to the server projects folder"','placeholder:ArchonCodex.runtime(s)==="codex"?"Defaults to local Codex projects folder":"Defaults to the server projects folder"','project folder hint');
 once('children:F.path}),r.jsxs("div",{style:{display:"flex",alignItems:"center",gap:14','children:(ArchonCodex.localProject(F.id)?"This PC · ":"")+F.path}),r.jsxs("div",{style:{display:"flex",alignItems:"center",gap:14','project card location');
 once('Z=I.projects,Y=n==="start"','Z=I.projects.filter(project=>ArchonCodex.localProject(project.id)===(ArchonCodex.activeRuntime(x,m,I)==="codex")),Y=n==="start"','composer projects');
 once('Ee=async()=>{const L=await st.pickFiles();if(!L.length)return;','Ee=async()=>{const L=await st.pickFiles();if(!L.length)return;if(ArchonCodex.activeRuntime(x,m,I)==="codex"){A(text=>text+(text?"\\n\\n":"")+"Local files selected for this session:\\n"+L.map(file=>"- "+file).join("\\n"));return}','local file attachments');
 once('Me=async L=>{const q=de?"attachments"','Me=async L=>{if(ArchonCodex.activeRuntime(x,m,I)==="codex"){w("Use Attach files to reference a local image in this Codex session.");return}const q=de?"attachments"','local image paste boundary');
 once('hint:"no project · runs from the Archon root"','hint:ArchonCodex.activeRuntime(x,m,I)==="codex"?"no project · local working directory":"no project · runs from the Archon root"','local general directory');

 block('function ASModels(){','function ASConnection(){',text=>{
  text=change(text,"const runtime=s.agentRuntime==='pi'?'pi':'prime';","const runtime=ArchonCodex.runtime(s),status=ArchonCodex.useStatus(),canSelect=runtime==='codex'?status.available&&status.authenticated:connected;",'models runtime');
  text=change(text,'const catalog=data.models.filter(m=>!m.hidden);','const catalog=ArchonCodex.models(data.models,runtime).filter(m=>!m.hidden);','runtime models');
  text=change(text,"return ASn('div',{className:'as-stack'},","return ASn('div',{className:'as-stack'},runtime==='codex'&&ASn(ArchonCodexNotice),",'local status');
  text=change(text,"note:'Both run on your MiniPC. Existing conversations keep their original agent.'","note:'Prime and Pi use your MiniPC server. Codex runs on this PC. Existing conversations keep their original agent.'",'agent locations');
  text=change(text,"['pi','Pi','ph-terminal-window','Your Pi coding agent runtime.']","['pi','Pi','ph-terminal-window','Your Pi coding agent runtime.'],['codex','Codex','ph-code','Your signed-in Codex CLI on this PC.']",'Codex card');
  text=change(text,"onClick:()=>patch({agentRuntime:id,activeSession:null,agent:''})","onClick:()=>patch(ArchonCodex.selection(s,id,data.models))",'agent selection');
  text=change(text,"ASn('small',null,'ARCHON MINIPC')","ASn('small',null,id==='codex'?'THIS PC':'ARCHON MINIPC')",'card location');
  text=change(text,"!connected&&ASn('div'","runtime!=='codex'&&!connected&&ASn('div'",'remote notice');
  text=change(text,"disabled:!connected,'aria-pressed':selected","disabled:!canSelect,'aria-pressed':selected",'local model controls');
  text=change(text,'onClick:()=>patch({model:m.id,modelProvider:m.provider})','onClick:()=>patch(ArchonCodex.chooseModel(s,m))','remember model');
  return text;
 },'models component');
 block('function wy(){','function by(){',()=>"function wy(){return ASn(ASModels)}\n",'legacy model component');
 block('function zy(){','const Tl=',()=>`function zy(){const{settings,patch,go,data}=Ne();return r.jsxs(Kt,{children:[r.jsx(pn,{title:"Agents",subtitle:"Prime and Pi use your MiniPC server. Codex runs on this PC. Conversations keep their original agent."}),r.jsx(ei,{children:["prime","pi","codex"].map(id=>r.jsxs("div",{style:{padding:18,border:"1px solid var(--ar-edge)",borderRadius:8,marginBottom:12},children:[r.jsx("h3",{children:ArchonCodex.label(id)}),r.jsx("p",{children:id==="codex"?"Runs on this PC using your signed-in Codex CLI.":"Runs on the Archon MiniPC."}),id==="codex"&&ASn(ArchonCodexNotice),r.jsx("button",{type:"button",className:"btn btn-primary",onClick:()=>{patch(ArchonCodex.selection(settings,id,data.models));go("new")},children:"New "+ArchonCodex.label(id)+" session"})]},id))})]})}`, 'agent page');

 once("function SSagent(s){return s.runtime==='pi'||s.source==='pi'||s.source==='pi-cli'?'pi':'prime'}",'function SSagent(s){return ArchonCodex.sessionRuntime(s)}','session runtime');
 once("ASicon(agent==='pi'?'ph-terminal-window':'ph-lightning'),agent==='pi'?'Pi':'Prime'","ASicon(agent==='codex'?'ph-code':agent==='pi'?'ph-terminal-window':'ph-lightning'),ArchonCodex.label(agent)",'session badge');
 once("SSagent($)==='pi'?'Pi':'Prime'",'ArchonCodex.label(SSagent($))','session list agent label');
 once("[['all','All'],['prime','Prime'],['pi','Pi']]","[['all','All'],['prime','Prime'],['pi','Pi'],['codex','Codex']]",'session filter');
 once('p.runtime==="pi"?"Pi":"Prime"','ArchonCodex.label(ArchonCodex.sessionRuntime(p))','titlebar session agent');

 // These labels live in separate existing components, so preserve their markup.
 const labelPattern=/([ns])\.agentRuntime===("|')pi\2\?("|')Pi\3:("|')Prime\4/g;
 const labels=[...source.matchAll(labelPattern)];if(labels.length!==3)throw Error('Codex runtime label anchors changed');
 source=source.replace(labelPattern,(_,id)=>`ArchonCodex.label(ArchonCodex.runtime(${id}))`);
 once("s.agentRuntime==='pi'?'pi':'prime'",'ArchonCodex.runtime(s)','diagnostic runtime');
 once('n.agentRuntime==="pi"?"Start a Pi session on the Archon MiniPC. Pi handles the next task through the remote server.":"Start a Prime session on the Archon MiniPC. Prime handles coding, debugging, testing, research, and execution directly."','ArchonCodex.runtime(n)==="codex"?"Start a Codex session on this PC. Codex works in your local project using your signed-in CLI.":n.agentRuntime==="pi"?"Start a Pi session on the Archon MiniPC. Pi handles the next task through the remote server.":"Start a Prime session on the Archon MiniPC. Prime handles coding, debugging, testing, research, and execution directly."','new-session description');
 once('n.agentRuntime==="pi"?"Next prompt opens a new Pi session on the MiniPC":"Next prompt opens a new Prime session on the MiniPC"','ArchonCodex.runtime(n)==="codex"?"Next prompt opens a new Codex session on this PC":n.agentRuntime==="pi"?"Next prompt opens a new Pi session on the MiniPC":"Next prompt opens a new Prime session on the MiniPC"','new-session hint');
 once('catch{return p(h?"The server refused the task":"Not connected to the MiniPC"),!1}','catch{return p(ArchonCodex.runtime(n)==="codex"?"Codex could not start. Check its sign-in and local project in Settings.":h?"The server refused the task":"Not connected to the MiniPC"),!1}','dispatch error');
 once('h("The server refused the turn")','h(ArchonCodex.localSession(E.id)?"Codex could not continue this turn. Check its sign-in and task details.":"The server refused the turn")','reply error');

 once("'A desktop for both agents'","'A desktop for your agents'",'general heading');
 once("'Prime and Pi work on the Archon MiniPC. Existing conversations keep their original agent.'","'Prime and Pi use your MiniPC server. Codex runs on this PC. Existing conversations keep their original agent.'",'general description');
 once("note:'All agent requests are sent to this address.'","note:'Prime and Pi requests are sent to this address. Codex runs locally on this PC.'",'connection description');
 once("ASn(ASrow,{title:'Agent runtimes'},'Prime / Pi')","ASn(ASrow,{title:'Agent runtimes'},'Prime / Pi / Codex (this PC)')",'about runtimes');
 once("ASn('small',null,'A path on the MiniPC, not this computer. Project folders take precedence.')","ASn('small',null,ArchonCodex.runtime(s)==='codex'?'A path on this PC. Project folders take precedence.':'A path on the MiniPC, not this computer. Project folders take precedence.')",'working directory location');

 once('const Se=f.models.filter(q=>!!q.provider);if(!x||!Se.length||Se.some(q=>q.id===s.model&&q.provider===s.modelProvider))return;','const Se=ArchonCodex.models(f.models,ArchonCodex.runtime(s));if((!x&&ArchonCodex.runtime(s)!=="codex")||!Se.length||Se.some(q=>q.id===s.model&&q.provider===s.modelProvider))return;','automatic model selection');
 once('[x,f.models,s.model,s.modelProvider,$]','[x,f.models,s.model,s.modelProvider,s.agentRuntime,s.activeProject,$]','model effect dependencies');
 once('catch{return Ie!==Z.current||(oe.current=!1,S(!1),v(null),F(null)),!1}','catch{if(Ie!==Z.current)return!1;oe.current=!1;S(!1);v(null);F(null);try{const local=await ArchonCodex.snapshot();if(Ie===Z.current)y(previous=>ArchonCodex.mergeLocal(previous,local,de.current))}catch{}return!1}','offline local hydration');
 once('r.jsx(of.Provider,{value:Ft,children:l?n:null})','r.jsx(of.Provider,{value:Ft,children:l?r.jsxs(r.Fragment,{children:[r.jsx(ArchonCodexBridge,{}),n]}):null})','status lifecycle');
 once('function ASModels(){',fs.readFileSync(path.join(__dirname,'codex-renderer.js'),'utf8')+'\nfunction ASModels(){','models component');
 return source;
}
module.exports={patchCodexRenderer};
