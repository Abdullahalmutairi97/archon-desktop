const ArchonCollabModel=(()=>{
 const MAX=1024*1024;
 const fail=()=>{throw Error('Invalid or oversized sharing code.')};
 const str=(s,max)=>typeof s==='string'&&s.length<=max;
 function validate(p){
  if(!p||p.type!=='archon-collab'||p.version!==2||!['session','project'].includes(p.kind)||!str(p.title,500)||!Array.isArray(p.sessions)||!p.sessions.length||p.sessions.length>100)fail();
  if(JSON.stringify(p).length>MAX)fail();
  const sessions=p.sessions.map(s=>{
   if(!s||!str(s.id,500)||!str(s.title,500)||!Array.isArray(s.messages)||s.messages.length>2000)fail();
   const messages=s.messages.map(m=>{if(!m||!['user','agent'].includes(m.role)||!str(m.content,MAX))fail();return {role:m.role,content:m.content}});
   return {id:s.id,title:s.title,messages};
  });
  return {type:p.type,version:2,kind:p.kind,title:p.title,sessions};
 }
 function create(kind,title,sessions){
  if(!sessions.length)throw Error('Choose a session or a project with sessions first.');
  return validate({type:'archon-collab',version:2,kind,title,sessions:sessions.map(s=>({id:s.id,title:s.title||'Untitled session',messages:(s.messages||[]).filter(m=>!m.nativeKind&&['user','agent','assistant'].includes(m.role)).map(m=>({role:m.role==='assistant'?'agent':m.role,content:m.content||''}))}))});
 }
 function encode(p){const bytes=new TextEncoder().encode(JSON.stringify(validate(p)));let s='';for(const b of bytes)s+=String.fromCharCode(b);return 'archon-snapshot:'+btoa(s)}
 function parse(input){
  if(!str(input,MAX*2))fail();const raw=input.trim();
  if(!raw.startsWith('archon-snapshot:'))fail();
  try{return validate(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(raw.slice(16)),c=>c.charCodeAt(0)))))}catch{fail()}
 }
 return {MAX,validate,create,encode,parse};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=ArchonCollabModel;
