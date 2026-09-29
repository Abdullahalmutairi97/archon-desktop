// Replaces the title bar's breadcrumb and "New: agent · model" pill with one title,
// and gives Share a place among the title bar icons.
function patchTitlebar(original){
 let source=original;
 const once=(before,after,label)=>{if(source.split(before).length!==2)throw Error(`Title bar ${label} target must occur exactly once`);source=source.replace(before,()=>after)};
 const start='r.jsx("span",{style:{fontSize:11.5,opacity:.5},children:(p?`${ArchonRuntime.label(ArchonRuntime.sessionRuntime(p))} · `:"")+py(o.view,p?.title??null,h?.name??null)})';
 const end='r.jsxs("div",{className:"no-drag",style:{marginInlineStart:"auto"';
 const a=source.indexOf(start),b=source.indexOf(end,a);
 if(a<0||b<0||source.indexOf(start,a+1)>=0)throw Error('Title bar breadcrumb boundary missing');
 const between=source.slice(a+start.length,b);
 if(!between.includes('title:"Select the MiniPC agent and model for new sessions"'))throw Error('Title bar agent pill changed');
 source=source.slice(0,a)+'r.jsx(ArchonTitle,{session:p,project:p?h:null,label:py(o.view,p?.title??null,h?.name??null)}),'+source.slice(b);
 once('r.jsx("div",{style:{width:"var(--archon-border-width)",height:16,background:"var(--archon-border)",margin:"0 5px"}})',
  'r.jsx("button",{type:"button",className:"reset-btn hov-tint ar-titlebar-share",onClick:()=>l({bench:null,collabOpen:!0}),title:"Share a read-only snapshot","aria-label":"Share sessions and projects",style:{...Vi,opacity:o.collabOpen?1:.45,color:o.collabOpen?"var(--archon-accent)":"inherit"},children:r.jsx("i",{className:"ph ph-share-network",style:{fontSize:15}})}),r.jsx("div",{style:{width:"var(--archon-border-width)",height:16,background:"var(--archon-border)",margin:"0 5px"}})','share button');
 return source;
}
module.exports={patchTitlebar};
