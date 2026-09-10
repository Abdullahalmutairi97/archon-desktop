// Shared by the packaged renderer and offline behavior tests. No filesystem access.
const ArchonIdeModel = (() => {
  function filePath(value, cwd='') {
    let p=String(value||'').trim().replace(/^<|>$/g,'').replace(/(?:#L\d+(?:C\d+)?|:\d+(?::\d+)?)$/,'');
    try { p=decodeURIComponent(p); } catch { return null; }
    if(!p || /[\x00-\x1f]/.test(p) || /^[a-z][a-z\d+.-]*:/i.test(p) || p.startsWith('//')) return null;
    if(!/\.(?:[a-z\d]{1,12})$/i.test(p) && !/(?:^|\/)(?:Dockerfile|Makefile|LICENSE)$/.test(p)) return null;
    if(!p.startsWith('/') && cwd) p=cwd.replace(/\/$/,'')+'/'+p;
    const absolute=p.startsWith('/'), parts=[];
    for(const bit of p.split('/')) { if(!bit||bit==='.')continue;if(bit==='..'){if(!parts.length)return null;parts.pop();}else parts.push(bit); }
    return (absolute?'/':'')+parts.join('/');
  }
  function collectArtifacts(messages,sessionId,cwd) {
    const items=[], files=new Set();
    const addFile=(raw,source)=>{const path=filePath(raw,cwd);if(path&&!files.has(path)){files.add(path);items.push({id:'file:'+path,kind:'file',path,label:path.split('/').pop(),source});}};
    for(const [mi,m] of (messages||[]).entries()) {
      if(m.role!=='agent'||m.nativeKind==='thinking'||m.nativeKind==='tool_result')continue;
      const source=m.id||String(mi), text=String(m.content||'');
      if(m.nativeKind==='tool') {
        const split=text.indexOf('\n'), name=text.slice(0,split<0?text.length:split);
        const raw=split<0?'':text.slice(split+1);
        if(/write|edit|patch/i.test(name)) {
          let args;try{args=JSON.parse(raw)}catch{}
          if(args&&typeof args==='object'){addFile(args.path||args.file_path||args.filename,source);}
          const patch=typeof args?.patch==='string'?args.patch:typeof args?.input==='string'?args.input:raw;
          for(const hit of patch.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm))addFile(hit[1],source);
          const code=args?.content??args?.new_string??args?.newText;
          if(typeof code==='string')items.push({id:'snippet:'+sessionId+':'+source+':tool',kind:'snippet',label:'Tool output · '+(args.path||args.file_path||'edit'),language:'text',content:code,source});
        }
        continue;
      }
      if(m.nativeKind)continue;
      // Parse line-based fences, including a currently streaming unfinished block.
      const lines=text.split(/\r?\n/);let fence=null, block=[], index=0, prose=[];
      const finish=()=>{const info=fence.info;const filename=info.match(/(?:file(?:name)?|path|title)=["']([^"']+)["']|(?:file(?:name)?|path|title)=(\S+)/i);const lang=info.split(/\s/)[0]||'text';const label=filename?.[1]||filename?.[2]||('Snippet '+(index+1)+' · '+lang);items.push({id:'snippet:'+sessionId+':'+source+':'+index++,kind:'snippet',label,language:lang,content:block.join('\n'),streaming:!!m.streaming,source});fence=null;block=[];};
      for(const line of lines){if(!fence){const hit=line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);if(hit){fence={mark:hit[1],info:hit[2].trim()};}else prose.push(line);}else if(new RegExp('^ {0,3}'+fence.mark[0]+'{'+fence.mark.length+',}\\s*$').test(line)){finish();}else block.push(line);}
      if(fence&&m.streaming)finish();
      const outside=prose.join('\n');
      for(const hit of outside.matchAll(/\[[^\]]+\]\((<[^>]+>|[^)]+)\)|`([^`\n]+)`/g))addFile(hit[1]||hit[2],source);
      for(const tool of m.tools||[])if(tool.kind==='diff')addFile(tool.target,source);
    }
    return items;
  }
  class Workspace {
    constructor(api){this.api=api;this.state={docs:{},tabs:[],active:''};this.listeners=new Set();this.requests=new Map();}
    snapshot=()=>this.state;
    subscribe=(listener)=>{this.listeners.add(listener);return()=>this.listeners.delete(listener)};
    publish(next){this.state=next;for(const listener of this.listeners)listener();}
    patch(id,change){const old=this.state.docs[id];if(old)this.publish({...this.state,docs:{...this.state.docs,[id]:{...old,...change}}});}
    isDirty(id){const d=this.state.docs[id];return !!d&&!d.readOnly&&d.text!==d.base;}
    select(id){if(this.state.docs[id])this.publish({...this.state,active:id});}
    async openFile(path,entry={},reload=false){
      if(entry.prot)return;
      const old=this.state.docs[path];
      if(old&&!reload&&(!old.error||this.isDirty(path))){this.select(path);return;}
      const token={};this.requests.set(path,token);
      this.publish({...this.state,active:path,tabs:this.state.tabs.includes(path)?this.state.tabs:[...this.state.tabs,path],docs:{...this.state.docs,[path]:{id:path,path,label:path.split('/').pop(),text:'',base:'',readOnly:true,loading:true,kind:'file'}}});
      try{const r=await this.api.readFileWindow(path,{maxBytes:500000});if(this.requests.get(path)!==token)return;this.patch(path,{text:r.content,base:r.content,loading:false,readOnly:!!(r.binary||r.truncated),notice:r.binary?'Binary preview — read-only':r.truncated?'Partial preview — read-only':''});}
      catch{if(this.requests.get(path)===token)this.patch(path,{loading:false,error:'Could not read this file. Retry when connected.',readOnly:true});}
    }
    openSnippet(item){this.publish({...this.state,active:item.id,tabs:this.state.tabs.includes(item.id)?this.state.tabs:[...this.state.tabs,item.id],docs:{...this.state.docs,[item.id]:{...item,text:item.content,base:item.content,readOnly:true}}});}
    syncSnippets(items){let changed=false,docs={...this.state.docs};for(const item of items){const d=docs[item.id];if(item.kind==='snippet'&&d&&(d.text!==item.content||d.streaming!==item.streaming)){docs[item.id]={...d,...item,text:item.content,base:item.content};changed=true;}}if(changed)this.publish({...this.state,docs});}
    edit(id,text){const d=this.state.docs[id];if(d&&!d.readOnly&&!d.loading)this.patch(id,{text});}
    close(id,discard=false){if(this.isDirty(id)&&!discard)return false;this.requests.delete(id);const tabs=this.state.tabs.filter(x=>x!==id),docs={...this.state.docs};delete docs[id];this.publish({...this.state,tabs,docs,active:this.state.active===id?(tabs[Math.max(0,this.state.tabs.indexOf(id)-1)]||tabs[0]||''):this.state.active});return true;}
    async save(id){const d=this.state.docs[id];if(!d||!this.isDirty(id)||d.saving)return;const text=d.text,base=d.base;this.patch(id,{saving:true,error:''});
      try{const remote=await this.api.readFileWindow(d.path,{maxBytes:500000});if(remote.binary||remote.truncated||remote.content!==base)throw Error('File changed on disk. Reload to review the agent’s changes before saving.');await this.api.writeFile(d.path,text);this.patch(id,{base:text,saving:false});}
      catch(error){this.patch(id,{saving:false,error:String(error.message||'Save failed')});}
    }
  }
  return {filePath,collectArtifacts,Workspace};
})();
if(typeof module!=='undefined')module.exports=ArchonIdeModel;
