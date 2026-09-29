// Shared by the packaged renderer and offline behavior tests. No filesystem access.
const ArchonGitModel=(()=>{
 function errorText(error){
  const raw=String(error?.message||error||'').replace(/^Error invoking remote method '[^']+': /,'').replace(/^Error: /,'');
  const hit=raw.match(/→ (\d{3})(?:: ([\s\S]+))?$/);
  if(/unauthorized/i.test(raw))return 'The server rejected this device token.';
  if(!hit)return raw||'The server did not answer.';
  if(hit[2])return hit[2].trim();
  return {404:'Not a Git repository.',403:'That path is outside the Archon root.',409:'Git refused the operation.'}[hit[1]]||'The server refused the request.';
 }
 function groups(files){
  const out={conflicted:[],staged:[],unstaged:[],untracked:[]};
  for(const f of files||[]){
   if(f.conflicted){out.conflicted.push(f);continue}
   if(f.untracked){out.untracked.push(f);continue}
   if(f.staged)out.staged.push(f);
   if(f.unstaged)out.unstaged.push(f);
  }
  return out;
 }
 const letter=(f,staged)=>f.conflicted?'U':f.untracked?'?':(staged?f.index:f.worktree)||'M';
 // Pairs each run of deletions with the additions that follow it, so a changed line sits beside its replacement.
 function sideBySide(lines){
  const rows=[];let dels=[],adds=[];
  const flush=()=>{for(let i=0;i<Math.max(dels.length,adds.length);i++)rows.push({left:dels[i]||null,right:adds[i]||null});dels=[];adds=[]};
  for(const line of lines||[]){
   if(line.kind==='del'){if(adds.length)flush();dels.push(line)}
   else if(line.kind==='add')adds.push(line);
   else{flush();if(line.kind==='ctx')rows.push({left:line,right:line});else rows.push({meta:line})}
  }
  flush();return rows;
 }
 const lineKey=(file,line)=>file+'#'+(line.new!=null?'n'+line.new:'o'+line.old);
 class Review{
  constructor(){this.items=[];this.listeners=new Set();this.version=0}
  subscribe=fn=>{this.listeners.add(fn);return()=>this.listeners.delete(fn)};
  snapshot=()=>this.version;
  emit(){this.version++;for(const fn of this.listeners)fn()}
  add(file,line,body,source=''){
   const text=String(body||'').trim();if(!text)return null;
   const item={id:Math.random().toString(36).slice(2),file,key:lineKey(file,line),side:line.new!=null?'new':'old',number:line.new??line.old,code:line.text,kind:line.kind,body:text,source};
   this.items.push(item);this.emit();return item;
  }
  remove(id){const before=this.items.length;this.items=this.items.filter(x=>x.id!==id);if(this.items.length!==before)this.emit()}
  clear(){if(this.items.length){this.items=[];this.emit()}}
  forLine(file,line){const key=lineKey(file,line);return this.items.filter(x=>x.key===key)}
  prompt(context){
   const lines=[`Code review${context?.label?' of '+context.label:''}${context?.root?' in '+context.root:''}. Please address each comment, then summarise what you changed.`,''];
   this.items.forEach((c,i)=>{
    lines.push(`${i+1}. ${c.file}:${c.number}${c.side==='old'?' (removed line)':''}`);
    if(c.code.trim())lines.push('   > '+c.code.trim().slice(0,300));
    for(const part of c.body.split('\n'))lines.push('   '+part);
   });
   return lines.join('\n');
  }
 }
 function scopeLabel(sel){
  if(!sel)return '';
  if(sel.scope==='staged')return 'staged changes';
  if(sel.scope==='unstaged')return 'working-tree changes';
  if(sel.scope==='commit')return 'commit '+String(sel.ref||'').slice(0,12);
  if(sel.scope==='compare')return (sel.ref||'HEAD')+' against '+sel.base;
  return '';
 }
 return {errorText,groups,letter,sideBySide,lineKey,Review,scopeLabel};
})();
if(typeof module!=='undefined')module.exports=ArchonGitModel;
