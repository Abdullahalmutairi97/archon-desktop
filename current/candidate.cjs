// Build a reviewed v0.3.0 candidate without changing the frozen release recipe.
// The shipped v0.3.0 app is a packaged renderer; this candidate keeps the
// official archive as its input and applies guarded, reversible UI additions.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const baseline = require('./baseline.json');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function verifyOfficial(bytes) {
  if (sha256(bytes) !== baseline.archiveSha256) {
    throw new Error('Wrong v0.3.0 archive: expected the verified unified-refresh release');
  }
}

const tabsBefore = 'const Qm=[{id:"activity",icon:"ph-pulse",title:"Activity"},{id:"files",icon:"ph-folder-open",title:"Files"},{id:"browser",icon:"ph-globe",title:"Browser"},{id:"notes",icon:"ph-note",title:"Notes"},{id:"terminal",icon:"ph-terminal-window",title:"Terminal"}]';
const tabsAfter = 'const Qm=[{id:"activity",icon:"ph-pulse",title:"Activity"},{id:"files",icon:"ph-folder-open",title:"Files"},{id:"ide",icon:"ph-code",title:"IDE"},{id:"browser",icon:"ph-globe",title:"Browser"},{id:"notes",icon:"ph-note",title:"Notes"},{id:"terminal",icon:"ph-terminal-window",title:"Terminal"}]';
const titleTabsBefore = 'const uy=[{id:"activity",icon:"ph-pulse",title:"Activity",live:!0},{id:"files",icon:"ph-folder-open",title:"Files"},{id:"browser",icon:"ph-globe",title:"Browser"},{id:"notes",icon:"ph-note",title:"Notes"},{id:"terminal",icon:"ph-terminal-window",title:"Terminal"}]';
const titleTabsAfter = 'const uy=[{id:"activity",icon:"ph-pulse",title:"Activity",live:!0},{id:"files",icon:"ph-folder-open",title:"Files"},{id:"ide",icon:"ph-code",title:"IDE"},{id:"browser",icon:"ph-globe",title:"Browser"},{id:"notes",icon:"ph-note",title:"Notes"},{id:"terminal",icon:"ph-terminal-window",title:"Terminal"}]';
const benchBefore = "ui.bench==='files'&&ASn(pf,{compact:true}),ui.bench==='browser'&&ASn(uf,{compact:true})";
const benchAfter = "ui.bench==='files'&&ASn(pf,{compact:true}),ui.bench==='ide'&&ASn(ArchonIde),ui.bench==='browser'&&ASn(uf,{compact:true})";
const shortcutBefore = 'x&&["1","2","3","4","5"].includes(y)';
const shortcutAfter = 'x&&["1","2","3","4","5","6"].includes(y)';
const shortcutTabsBefore = '["activity","files","browser","notes","terminal"]';
const shortcutTabsAfter = '["activity","files","ide","browser","notes","terminal"]';

// A compact VS Code-like workspace built on the v0.3.0 bridge. The file tree,
// read/write calls and terminal all retain the packaged app's server-side
// permissions; this only supplies the familiar editor chrome around them.
const ideHelper = String.raw`function ArchonIde(){const {connected:online,say}=Ne();const [surface,setSurface]=k.useState('editor');const [folder,setFolder]=k.useState('.');const [entries,setEntries]=k.useState(online?[]:(typeof np!=='undefined'?np:[]));const [tabs,setTabs]=k.useState([]);const [active,setActive]=k.useState('');const [docs,setDocs]=k.useState({});const [dirty,setDirty]=k.useState({});const [loading,setLoading]=k.useState(false);const [scrollTop,setScrollTop]=k.useState(0);const lineRef=k.useRef(null);const join=(dir,name)=>dir==='.'?name:(dir?dir+'/'+name:name);const parent=dir=>dir==='.'?'.':dir.split('/').slice(0,-1).join('/')||'.';const refresh=async()=>{if(!online){setEntries(typeof np!=='undefined'?np:[]);return}setLoading(true);try{setEntries(await K.files(folder))}catch{setEntries([]);say('Could not list that folder')}finally{setLoading(false)}};k.useEffect(()=>{void refresh()},[online,folder]);const open=async(entry)=>{const path=entry.path||join(folder,entry.name);if(entry.kind==='dir'){setFolder(path);return}setActive(path);setTabs(current=>current.includes(path)?current:[...current,path]);if(docs[path]!==undefined)return;setDocs(current=>({...current,[path]:'Loading…'}));try{const result=await K.readFileWindow(path,{maxBytes:500000});setDocs(current=>({...current,[path]:result.content}));setDirty(current=>({...current,[path]:false}))}catch{setDocs(current=>({...current,[path]:'Could not read this file.'}));say('Could not read that file')}};const close=path=>{setTabs(current=>current.filter(item=>item!==path));setActive(current=>current===path?'':current)};const save=async()=>{if(!active||dirty[active]===false)return;try{await K.writeFile(active,docs[active]??'');setDirty(current=>({...current,[active]:false}));say('Saved')}catch{say('The write was refused')}};k.useEffect(()=>{const handler=event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='s'){event.preventDefault();void save()}};window.addEventListener('keydown',handler);return()=>window.removeEventListener('keydown',handler)},[active,docs,dirty]);const content=active?String(docs[active]??''):'';const lines=content.split('\\n');const filename=active.split('/').pop()||'No file open';const extension=(filename.includes('.')?filename.split('.').pop():'Plain Text').toUpperCase();const tabButton=(id,icon,label)=>ASn('button',{type:'button',className:'reset-btn',role:'tab','aria-selected':surface===id,onClick:()=>setSurface(id),style:{display:'flex',alignItems:'center',gap:6,padding:'5px 9px',borderRadius:'var(--radius-md)',fontSize:11.5,cursor:'pointer',color:surface===id?'var(--color-accent)':'inherit',opacity:surface===id?1:.6,background:surface===id?'var(--ar-hover)':'transparent'}},ASicon(icon),ASn('span',null,label));const fileButton=entry=>{const path=entry.path||join(folder,entry.name);const selected=path===active;return ASn('button',{key:path,type:'button',className:'reset-btn',onClick:()=>void open(entry),title:path,style:{width:'100%',display:'flex',alignItems:'center',gap:7,padding:'5px 9px',borderRadius:'var(--radius-sm)',textAlign:'start',fontSize:11.5,cursor:'pointer',color:selected?'var(--color-accent)':'inherit',background:selected?'var(--ar-hover)':'transparent'}},ASicon(entry.kind==='dir'?'ph-folder':entry.kind==='md'?'ph-file-text':'ph-file'),ASn('span',{style:{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},entry.name),entry.kind!=='dir'&&ASn('span',{style:{marginInlineStart:'auto',fontSize:9.5,opacity:.35}},entry.size||''))};const editor=ASn('div',{style:{flex:1,minHeight:0,display:'flex',flexDirection:'column'}},ASn('div',{style:{flex:'none',display:'flex',alignItems:'center',height:34,overflowX:'auto',borderBottom:'1px solid var(--ar-edge)',background:'var(--ar-panel)'}},tabs.map(path=>ASn('div',{key:path,style:{display:'flex',alignItems:'center',height:'100%',borderInlineEnd:'1px solid var(--ar-edge)',background:path===active?'var(--color-surface)':'transparent'}},ASn('button',{type:'button',className:'reset-btn',onClick:()=>setActive(path),style:{height:'100%',maxWidth:150,padding:'0 9px',fontSize:10.5,opacity:path===active?1:.58,cursor:'pointer',color:path===active?'var(--color-accent)':'inherit',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},path.split('/').pop(),dirty[path]&&' •'),ASn('button',{type:'button',className:'reset-btn',title:'Close file',onClick:()=>close(path),style:{width:22,height:22,display:'grid',placeItems:'center',opacity:.45,cursor:'pointer'}},ASicon('ph-x')))),!tabs.length&&ASn('span',{style:{padding:'0 11px',fontSize:10.5,opacity:.38}},'Open a file from Explorer')),ASn('div',{style:{flex:'none',display:'flex',alignItems:'center',gap:8,height:31,padding:'0 11px',borderBottom:'1px solid var(--ar-edge)',fontSize:10.5,opacity:.65}},ASicon('ph-file-code'),ASn('span',{style:{fontFamily:'var(--font-mono)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},active||'Select a file'),active&&ASn('span',{style:{marginInlineStart:'auto'}},dirty[active]?'Unsaved':'Saved')),active?ASn('div',{style:{flex:1,minHeight:0,display:'flex',overflow:'hidden',background:'#101216'}},ASn('div',{ref:lineRef,style:{width:48,flex:'none',overflow:'hidden',paddingTop:13,textAlign:'end',fontFamily:'var(--font-mono)',fontSize:11,lineHeight:1.7,color:'#687080',userSelect:'none',transform:scrollTop?'translateY(-'+scrollTop+'px)':'none'},children:lines.map((_,index)=>ASn('div',{key:index,style:{height:'1.7em',paddingInlineEnd:10}},index+1))}),ASn('textarea',{value:content,onChange:event=>{setDocs(current=>({...current,[active]:event.target.value}));setDirty(current=>({...current,[active]:true}))},onScroll:event=>setScrollTop(event.currentTarget.scrollTop),spellCheck:false,className:'ltr',style:{flex:1,minWidth:0,minHeight:0,resize:'none',border:0,outline:0,padding:'13px 14px',background:'transparent',color:'#d8dee9',fontFamily:'var(--font-mono)',fontSize:11,lineHeight:1.7,tabSize:2}},active):ASn('div',{style:{flex:1,display:'grid',placeItems:'center',padding:24,textAlign:'center',color:'#9aa3b5'}},ASicon('ph-code', {style:{fontSize:26,opacity:.35}}),ASn('span',{style:{fontSize:12,opacity:.65}},'Pick a file from Explorer to start editing'))),ASn('div',{style:{flex:'none',display:'flex',alignItems:'center',gap:8,height:24,padding:'0 10px',borderTop:'1px solid #252b3b',background:'#1b1f29',fontFamily:'var(--font-mono)',fontSize:9.5,color:'#9aa8c0'}},ASn('span',null,extension),ASn('span',null,'UTF-8'),ASn('span',{style:{marginInlineStart:'auto'}},'Ln '+(active?'1':'—')+', Col 1'),ASn('span',null,'Ctrl+S')));return ASn('div',{style:{flex:1,minHeight:0,display:'flex',flexDirection:'column'}},ASn('div',{style:{flex:'none',display:'flex',alignItems:'center',gap:2,padding:'7px 9px',borderBottom:'1px solid var(--ar-edge)'}},tabButton('editor','ph-code','Editor'),tabButton('terminal','ph-terminal-window','Terminal'),ASn('span',{style:{marginInlineStart:'auto',fontSize:10,opacity:.4}},'IDE')),surface==='terminal'?ASn(ey):ASn('div',{style:{flex:1,minHeight:0,display:'flex'}},ASn('aside',{style:{width:194,flex:'none',minHeight:0,display:'flex',flexDirection:'column',borderInlineEnd:'1px solid var(--ar-edge)',background:'var(--ar-panel)'}},ASn('div',{style:{flex:'none',display:'flex',alignItems:'center',gap:7,height:34,padding:'0 10px',borderBottom:'1px solid var(--ar-edge)',fontSize:10.5,letterSpacing:'.08em',textTransform:'uppercase',opacity:.62}},ASicon('ph-folder-open'),ASn('span',null,'Explorer'),ASn('button',{type:'button',className:'reset-btn',title:'Refresh explorer',onClick:()=>void refresh(),style:{marginInlineStart:'auto',opacity:.75,cursor:'pointer'}},ASicon(loading?'ph-spinner-gap':'ph-arrow-clockwise'))),ASn('div',{style:{flex:'none',display:'flex',alignItems:'center',gap:5,height:30,padding:'0 9px',borderBottom:'1px solid var(--ar-edge)',fontSize:10.5,fontFamily:'var(--font-mono)',overflow:'hidden',whiteSpace:'nowrap'}},ASn('button',{type:'button',className:'reset-btn',onClick:()=>setFolder('.'),title:'Workspace root',style:{opacity:folder==='.'?1:.6,cursor:'pointer'}},'root'),folder!=='.'&&ASn('button',{type:'button',className:'reset-btn',onClick:()=>setFolder(parent(folder)),title:'Up one folder',style:{opacity:.7,cursor:'pointer'}},' ..')),ASn('div',{style:{flex:1,minHeight:0,overflowY:'auto',padding:'6px'}},entries.map(fileButton),!entries.length&&ASn('span',{style:{display:'block',padding:12,fontSize:10.5,opacity:.4}},online?'Folder is empty':'Connect to the MiniPC to browse files'))),editor));}`;

// This replacement is deliberately composed from arrays so the packaged
// renderer remains readable and the editor controls stay easy to audit.
const ideHelperV2 = String.raw`
function ArchonIde(){
 const {connected:online,say,data}=Ne();
 const [surface,setSurface]=k.useState('editor');
 const [folder,setFolder]=k.useState('.');
 const [entries,setEntries]=k.useState(online?[]:(typeof np!=='undefined'?np:[]));
 const [tabs,setTabs]=k.useState([]);
 const [active,setActive]=k.useState('');
 const [docs,setDocs]=k.useState({});
 const [dirty,setDirty]=k.useState({});
 const [loading,setLoading]=k.useState(false);
 const [scrollTop,setScrollTop]=k.useState(0);
 const agentSnippets=[];
 for(const message of data.thread??[]){
  if(message.role!=='agent')continue;
  const source=String(message.content??'');
  const fence=String.fromCharCode(96,96,96);
  const blockRe=new RegExp(fence+'([^\\n]*)\\n([\\s\\S]*?)'+fence,'g');
  let match;
  while((match=blockRe.exec(source))){
   const code=match[2].replace(/\r?\n$/,'');
   if(!code.trim())continue;
   const info=match[1].trim();
   const bits=info.split(/\s+/);
   const lang=(bits[0]||'text').toLowerCase();
   const fileMatch=info.match(/(?:file|filename|path|title)\s*=\s*(?:"([^"]+)"|'([^']+)'|(\S+))/i);
   const baseLabel=(fileMatch&&(fileMatch[1]||fileMatch[2]||fileMatch[3]))||'agent-snippet-'+(agentSnippets.length+1);
   const label=baseLabel.includes('.')?baseLabel:baseLabel+'.'+(lang==='text'?'txt':lang);
   agentSnippets.push({id:'agent://'+(agentSnippets.length+1)+'-'+label.replace(/[^a-zA-Z0-9._-]+/g,'-'),label,lang,code});
  }
 }
 const recentAgentSnippets=agentSnippets.slice(-8).reverse();
 const join=(dir,name)=>dir==='.'?name:(dir?dir+'/'+name:name);
 const parent=dir=>dir==='.'?'.':dir.split('/').slice(0,-1).join('/')||'.';
 const refresh=async()=>{
  if(!online){setEntries(typeof np!=='undefined'?np:[]);return}
  setLoading(true);
  try{setEntries(await K.files(folder))}catch{setEntries([]);say('Could not list that folder')}finally{setLoading(false)}
 };
 k.useEffect(()=>{void refresh()},[online,folder]);
 const open=async(entry)=>{
  const path=entry.path||join(folder,entry.name);
  if(entry.kind==='dir'){setFolder(path);return}
  setActive(path);setTabs(current=>current.includes(path)?current:[...current,path]);
  if(docs[path]!==undefined)return;
  setDocs(current=>({...current,[path]:'Loading…'}));
  try{const result=await K.readFileWindow(path,{maxBytes:500000});setDocs(current=>({...current,[path]:result.content}));setDirty(current=>({...current,[path]:false}))}
 catch{setDocs(current=>({...current,[path]:'Could not read this file.'}));say('Could not read that file')}
 };
 const openAgent=snippet=>{
  setSurface('editor');setActive(snippet.id);setTabs(current=>current.includes(snippet.id)?current:[...current,snippet.id]);
  setDocs(current=>({...current,[snippet.id]:snippet.code}));setDirty(current=>({...current,[snippet.id]:false}));
 };
 const close=path=>{setTabs(current=>current.filter(item=>item!==path));setActive(current=>current===path?'':current)};
 const activeAgent=agentSnippets.find(item=>item.id===active);
 const agentDocument=active.indexOf('agent://')===0;
 const save=async()=>{
  if(agentDocument||!active||dirty[active]!==true)return;
  try{await K.writeFile(active,docs[active]??'');setDirty(current=>({...current,[active]:false}));say('Saved')}
  catch{say('The write was refused')}
 };
 k.useEffect(()=>{const handler=event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='s'){event.preventDefault();void save()}};window.addEventListener('keydown',handler);return()=>window.removeEventListener('keydown',handler)},[active,docs,dirty]);
 const content=active?String(docs[active]??''):'';
 const lines=content.split('\n');
 const filename=activeAgent?.label||active.split('/').pop()||'No file open';
 const extension=(filename.includes('.')?filename.split('.').pop():'Plain Text').toUpperCase();
 const tabButton=(id,icon,label)=>ASn('button',{type:'button',className:'reset-btn',role:'tab','aria-selected':surface===id,onClick:()=>setSurface(id),style:{display:'flex',alignItems:'center',gap:6,padding:'5px 9px',borderRadius:'var(--radius-md)',fontSize:11.5,cursor:'pointer',color:surface===id?'var(--color-accent)':'inherit',opacity:surface===id?1:.6,background:surface===id?'var(--ar-hover)':'transparent'}},ASicon(icon),ASn('span',null,label));
 const fileButton=entry=>{
  const path=entry.path||join(folder,entry.name);const selected=path===active;
  return ASn('button',{key:path,type:'button',className:'reset-btn',onClick:()=>void open(entry),title:path,style:{width:'100%',display:'flex',alignItems:'center',gap:7,padding:'5px 9px',borderRadius:'var(--radius-sm)',textAlign:'start',fontSize:11.5,cursor:'pointer',color:selected?'var(--color-accent)':'inherit',background:selected?'var(--ar-hover)':'transparent'}},ASicon(entry.kind==='dir'?'ph-folder':entry.kind==='md'?'ph-file-text':'ph-file'),ASn('span',{style:{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},entry.name),entry.kind!=='dir'&&ASn('span',{style:{marginInlineStart:'auto',fontSize:9.5,opacity:.35}},entry.size||''))
 };
 const openTabs=tabs.map(path=>ASn('div',{key:path,style:{display:'flex',alignItems:'center',height:'100%',borderInlineEnd:'1px solid var(--ar-edge)',background:path===active?'var(--color-surface)':'transparent'}},ASn('button',{type:'button',className:'reset-btn',onClick:()=>setActive(path),style:{height:'100%',maxWidth:150,padding:'0 9px',fontSize:10.5,opacity:path===active?1:.58,cursor:'pointer',color:path===active?'var(--color-accent)':'inherit',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},path.split('/').pop(),dirty[path]&&' •'),ASn('button',{type:'button',className:'reset-btn',title:'Close file',onClick:()=>close(path),style:{width:22,height:22,display:'grid',placeItems:'center',opacity:.45,cursor:'pointer'}},ASicon('ph-x'))));
 const editor=ASn('div',{style:{flex:1,minHeight:0,display:'flex',flexDirection:'column'}},[
  ASn('div',{style:{flex:'none',display:'flex',alignItems:'center',height:34,overflowX:'auto',borderBottom:'1px solid var(--ar-edge)',background:'var(--ar-panel)'}},tabs.length?openTabs:ASn('span',{style:{padding:'0 11px',fontSize:10.5,opacity:.38}},'Open a file from Explorer')),
  ASn('div',{style:{flex:'none',display:'flex',alignItems:'center',gap:8,height:31,padding:'0 11px',borderBottom:'1px solid var(--ar-edge)',fontSize:10.5,opacity:.65}},[ASicon(agentDocument?'ph-sparkle':'ph-file-code'),ASn('span',{style:{fontFamily:pe,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},agentDocument?'Agent output · '+filename:active||'Select a file'),active&&ASn('span',{style:{marginInlineStart:'auto'}},agentDocument?'Read-only':dirty[active]?'Unsaved':'Saved'),active&&dirty[active]===true&&!agentDocument&&ASn('button',{type:'button',className:'btn btn-primary',onClick:()=>void save(),style:{height:22,fontSize:10,padding:'0 8px'}},'Save')]),
  active?ASn('div',{style:{flex:1,minHeight:0,display:'flex',overflow:'hidden',background:'#101216'}},[ASn('div',{style:{width:48,flex:'none',overflow:'hidden',paddingTop:13,textAlign:'end',fontFamily:pe,fontSize:11,lineHeight:1.7,color:'#687080',userSelect:'none',transform:scrollTop?'translateY(-'+scrollTop+'px)':'none'}},lines.map((_,index)=>ASn('div',{key:index,style:{height:'1.7em',paddingInlineEnd:10}},index+1))),ASn('textarea',{value:content,readOnly:agentDocument,onChange:event=>{if(agentDocument)return;setDocs(current=>({...current,[active]:event.target.value}));setDirty(current=>({...current,[active]:true}))},onScroll:event=>setScrollTop(event.currentTarget.scrollTop),spellCheck:false,className:'ltr',style:{flex:1,minWidth:0,minHeight:0,resize:'none',border:0,outline:0,padding:'13px 14px',background:'transparent',color:'#d8dee9',fontFamily:pe,fontSize:11,lineHeight:1.7,tabSize:2}})]):ASn('div',{style:{flex:1,display:'grid',placeItems:'center',padding:24,textAlign:'center',color:'#9aa3b5'}},[ASicon('ph-code',{style:{fontSize:26,opacity:.35}}),ASn('span',{style:{fontSize:12,opacity:.65}},'Pick a file from Explorer to start editing')]),
  ASn('div',{style:{flex:'none',display:'flex',alignItems:'center',gap:8,height:24,padding:'0 10px',borderTop:'1px solid #252b3b',background:'#1b1f29',fontFamily:pe,fontSize:9.5,color:'#9aa8c0'}},[ASn('span',null,extension),ASn('span',null,'UTF-8'),ASn('span',{style:{marginInlineStart:'auto'}},'Ln '+(active?'1':'—')+', Col 1'),ASn('span',null,'Ctrl+S')])
 ]);
 return ASn('div',{style:{flex:1,minHeight:0,display:'flex',flexDirection:'column'}},[
  ASn('div',{style:{flex:'none',display:'flex',alignItems:'center',gap:2,padding:'7px 9px',borderBottom:'1px solid var(--ar-edge)'}},[tabButton('editor','ph-code','Editor'),tabButton('terminal','ph-terminal-window','Terminal'),recentAgentSnippets.length&&ASn('button',{type:'button',className:'reset-btn',onClick:()=>openAgent(recentAgentSnippets[0]),style:{display:'flex',alignItems:'center',gap:5,padding:'5px 9px',borderRadius:'var(--radius-md)',fontSize:11.5,cursor:'pointer',color:agentDocument?'var(--color-accent)':'inherit',opacity:agentDocument?1:.6,background:agentDocument?'var(--ar-hover)':'transparent'}},ASicon('ph-sparkle'),ASn('span',null,'Agent code'),ASn('span',{style:{fontSize:9,opacity:.65}},agentSnippets.length)),ASn('span',{style:{marginInlineStart:'auto',fontSize:10,opacity:.4}},'IDE')]),
  surface==='terminal'?ASn(ey):ASn('div',{style:{flex:1,minHeight:0,display:'flex'}},[ASn('aside',{style:{width:194,flex:'none',minHeight:0,display:'flex',flexDirection:'column',borderInlineEnd:'1px solid var(--ar-edge)',background:'var(--ar-panel)'}},[ASn('div',{style:{flex:'none',display:'flex',alignItems:'center',gap:7,height:34,padding:'0 10px',borderBottom:'1px solid var(--ar-edge)',fontSize:10.5,letterSpacing:'.08em',textTransform:'uppercase',opacity:.62}},[ASicon('ph-folder-open'),ASn('span',null,'Explorer'),ASn('button',{type:'button',className:'reset-btn',title:'Refresh explorer',onClick:()=>void refresh(),style:{marginInlineStart:'auto',opacity:.75,cursor:'pointer'}},ASicon(loading?'ph-spinner-gap':'ph-arrow-clockwise'))]),recentAgentSnippets.length&&ASn('div',{style:{flex:'none',maxHeight:134,overflowY:'auto',padding:'5px 6px',borderBottom:'1px solid var(--ar-edge)',background:'var(--ar-panel)'}},[ASn('div',{style:{display:'flex',alignItems:'center',gap:6,padding:'3px 4px 5px',fontSize:9.5,letterSpacing:'.08em',textTransform:'uppercase',opacity:.5}},[ASicon('ph-sparkle'),ASn('span',null,'Agent code'),ASn('span',{style:{marginInlineStart:'auto'}},agentSnippets.length)]),recentAgentSnippets.map(snippet=>ASn('button',{key:snippet.id,type:'button',className:'reset-btn',onClick:()=>openAgent(snippet),title:snippet.label,style:{width:'100%',display:'flex',alignItems:'center',gap:6,padding:'4px 5px',borderRadius:'var(--radius-sm)',textAlign:'start',fontSize:10.5,cursor:'pointer',color:active===snippet.id?'var(--color-accent)':'inherit',background:active===snippet.id?'var(--ar-hover)':'transparent'}},ASicon('ph-code'),ASn('span',{style:{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},snippet.label),ASn('span',{style:{marginInlineStart:'auto',fontSize:9,opacity:.42}},snippet.lang+' · '+snippet.code.split('\n').length+'L')))]),ASn('div',{style:{flex:'none',display:'flex',alignItems:'center',gap:5,height:30,padding:'0 9px',borderBottom:'1px solid var(--ar-edge)',fontSize:10.5,fontFamily:pe,overflow:'hidden',whiteSpace:'nowrap'}},[ASn('button',{type:'button',className:'reset-btn',onClick:()=>setFolder('.'),title:'Workspace root',style:{opacity:folder==='.'?1:.6,cursor:'pointer'}},'root'),folder!=='.'&&ASn('button',{type:'button',className:'reset-btn',onClick:()=>setFolder(parent(folder)),title:'Up one folder',style:{opacity:.7,cursor:'pointer'}},' ..')]),ASn('div',{style:{flex:1,minHeight:0,overflowY:'auto',padding:'6px'}},[entries.map(fileButton),!entries.length&&ASn('span',{style:{display:'block',padding:12,fontSize:10.5,opacity:.4}},online?'Folder is empty':'Connect to the MiniPC to browse files')])]),editor])
 ]);
}`;

// The browser starts with the configured shortcuts. This small result strip
// adds links found in the agent's visible transcript, so a finished task can
// open its cited work in the same side panel without copying URLs by hand.
const linksHelper = String.raw`function ArchonResultLinks({onOpen}){const {data}=Ne();const links=[];for(const message of data.thread??[]){if(message.role!=='agent')continue;const found=String(message.content??'').match(/https?:\/\/[^\s<>"')\]]+/g)||[];for(const raw of found){const url=raw.replace(/[.,;:!?]+$/,'');if(url&&!links.includes(url))links.push(url)}}const recent=links.slice(-6);if(!recent.length)return null;return r.jsxs('div',{style:{flex:'none',display:'flex',flexDirection:'column',gap:6,padding:'8px 10px 10px',borderTop:'1px solid var(--ar-edge)',background:'var(--ar-panel)'},children:[r.jsxs('div',{style:{display:'flex',alignItems:'center',gap:6,fontSize:10,letterSpacing:'.08em',textTransform:'uppercase',opacity:.48},children:[r.jsx('i',{className:'ph ph-link-simple',style:{fontSize:12}}),r.jsx('span',{children:'From agent result'})]}),r.jsx('div',{style:{display:'flex',gap:6,flexWrap:'wrap'},children:recent.map(url=>r.jsxs('button',{type:'button',onClick:()=>onOpen(url),className:'reset-btn hov-tint',title:url,style:{display:'flex',alignItems:'center',gap:5,maxWidth:'100%',padding:'4px 8px',border:'1px solid var(--ar-edge)',borderRadius:999,fontSize:10.5,cursor:'pointer'},children:[r.jsx('i',{className:'ph ph-arrow-up-right',style:{fontSize:11}}),r.jsx('span',{style:{maxWidth:220,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'},children:url.replace(/^https?:\/\//,'')})]},url))})]})}`;

function patchRenderer(original) {
  let result = original;
  const replaceOnce = (before, after, label) => {
    if (result.split(before).length !== 2) throw new Error(`${label} target must occur exactly once`);
    result = result.replace(before, after);
  };

  replaceOnce(tabsBefore, tabsAfter, 'workbench tabs');
  replaceOnce(titleTabsBefore, titleTabsAfter, 'titlebar tabs');
  replaceOnce(shortcutBefore, shortcutAfter, 'shortcut count');
  replaceOnce(shortcutTabsBefore, shortcutTabsAfter, 'shortcut tab order');
  replaceOnce(benchBefore, benchAfter, 'IDE render branch');

  // Keep the helper in the renderer's module scope. Function declarations are
  // hoisted, so it can use the existing React and component aliases.
  replaceOnce('function ty(){', `${linksHelper}\n${ideHelperV2}\nfunction ty(){`, 'workbench helper anchor');

  // Render transcript links below the browser's empty-state shortcuts. The
  // exact anchor is stable in the verified v0.3.0 bundle and is guarded here.
  const resultStripAnchor = 'E&&!A&&r.jsx("div",{style:{flex:"none",display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",padding:n?"0 10px 12px":"0 14px 14px"},children:Wm(s.serverUrl).map(P=>r.jsxs("button"';
  if (result.split(resultStripAnchor).length !== 2) throw new Error('browser result-link anchor must occur exactly once');
  result = result.replace(resultStripAnchor, `${resultStripAnchor}`);
  // Insert the component after the existing shortcut strip without changing
  // that strip's behavior. The closing `})]})}` is unique in this block.
  const shortcutStrip = '})]})}const Bm=typeof navigator';
  if (result.split(shortcutStrip).length !== 2) throw new Error('browser shortcut strip terminator must occur exactly once');
  result = result.replace(shortcutStrip, '}),r.jsx(ArchonResultLinks,{onOpen:w})]})}const Bm=typeof navigator');

  return result;
}

async function build(args) {
  if (args.length !== 2) throw new Error('Usage: npm run build:candidate -- /path/to/v0.3.0.asar /new/candidate.asar');
  const [input, output] = args.map(value => path.resolve(value));
  if (fs.existsSync(output)) throw new Error('Output already exists; choose a new candidate path');
  verifyOfficial(fs.readFileSync(input));
  const asar = require('@electron/asar');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'archon-v030-candidate-'));
  try {
    const app = path.join(temp, 'app');
    asar.extractAll(input, app);
    const renderer = path.join(app, baseline.rendererPath);
    const patched = patchRenderer(fs.readFileSync(renderer, 'utf8'));
    const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: patched, encoding: 'utf8' });
    if (syntax.error) throw syntax.error;
    if (syntax.status !== 0) throw new Error(`Candidate renderer failed JavaScript syntax validation: ${syntax.stderr}`);
    fs.writeFileSync(renderer, patched);
    const pkg = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
    if (pkg.version !== baseline.version) throw new Error(`Candidate package must remain v${baseline.version}`);
    await asar.createPackage(app, output);
    console.log(`Built v${pkg.version} candidate: ${output}\nsha256 ${sha256(fs.readFileSync(output))}`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

module.exports = { patchRenderer, verifyOfficial };
if (require.main === module) build(process.argv.slice(2)).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
