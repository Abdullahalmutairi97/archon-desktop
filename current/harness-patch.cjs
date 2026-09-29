// Adds Settings → Agent harnesses, and keeps turned-off agents from being picked.
function patchHarnesses(original){
 let source=original;
 const once=(before,after,label)=>{if(source.split(before).length!==2)throw Error(`Harness ${label} target must occur exactly once`);source=source.replace(before,()=>after)};
 once("words:'prime pi astra provider pins'},","words:'prime pi astra provider pins'},\n  {id:'harnesses', group:'WORKSPACE', icon:'ph-plugs', label:'Agent harnesses', note:'Install, check and control the agents on your MiniPC.', words:'harness prime pi opencode version update install turn on off'},",'settings item');
 once("let content=tab==='models'?ASn(ASModels):","let content=tab==='models'?ASn(ASModels):tab==='harnesses'?ASn(ArchonHarnesses):",'settings page');
 once('const runtime=ArchonRuntime.runtime(s);','const runtime=ArchonRuntime.runtime(s);ArchonHarnessStore.use();','models harness state');
 once("className:'as-agent'+(runtime===id?' is-selected':''),onClick:()=>patch(ArchonRuntime.selection(s,id,data.models))","className:'as-agent'+(runtime===id?' is-selected':''),disabled:ArchonHarnessStore.off(id),title:ArchonHarnessStore.off(id)?'Turned off in Agent harnesses':undefined,onClick:()=>patch(ArchonRuntime.selection(s,id,data.models))",'agent card');
 once("ASn('small',null,'ARCHON MINIPC')","ASn('small',null,ArchonHarnessStore.off(id)?'TURNED OFF':'ARCHON MINIPC')",'agent card location');
 once('onClick:()=>{patch(ArchonRuntime.selection(settings,id,data.models));go("new")}','disabled:ArchonHarnessStore.off(id),onClick:()=>{patch(ArchonRuntime.selection(settings,id,data.models));go("new")}','agent page');
 return source;
}
module.exports={patchHarnesses};
