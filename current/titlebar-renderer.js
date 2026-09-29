// Title bar: what you are looking at, and the session's agent as a quiet icon.
function ArchonTitle({session,project,label}){
 const agent=session?ArchonRuntime.sessionRuntime(session):null;
 const icon=agent==='opencode'?'ph-code':agent==='pi'?'ph-terminal-window':'ph-lightning';
 const text=session?session.title||label:label;
 return ASn('div',{className:'ar-title'},ASn('style',null,ARCHON_TITLE_CSS),
  agent&&ASn('span',{className:'ar-title-agent',title:ArchonRuntime.label(agent)+' session','aria-label':ArchonRuntime.label(agent)+' session'},ASicon(icon)),
  project&&ASn(k.Fragment,null,ASn('span',{className:'ar-title-project'},project.name),ASn('span',{className:'ar-title-sep','aria-hidden':true},'/')),
  ASn('span',{className:'ar-title-text',title:text},text));
}
const ARCHON_TITLE_CSS=`
.ar-title{display:flex;align-items:center;gap:7px;min-width:0;flex:0 1 auto;font-size:12px;line-height:1}.ar-title-agent{display:grid;place-items:center;width:20px;height:20px;flex:none;border-radius:6px;background:var(--ar-hover);color:var(--archon-accent,var(--color-accent));font-size:12px}.ar-title-project{opacity:.45;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px}.ar-title-sep{opacity:.3}.ar-title-text{opacity:.85;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}.ar-titlebar-share{border:0;background:transparent;color:inherit;cursor:pointer}.ar-titlebar-share:focus-visible{outline:1px solid var(--archon-accent,var(--color-accent));opacity:1!important}
`;
