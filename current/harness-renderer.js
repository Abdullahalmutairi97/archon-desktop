// Settings → Agent harnesses: what is installed on the MiniPC, and control over it.
const ArchonHarnessStore=(()=>{
 let state={loading:true,rows:[],error:''};const listeners=new Set();let pending=null;
 const set=next=>{state=next;for(const fn of listeners)fn()};
 async function refresh(){
  if(pending)return pending;
  pending=(async()=>{try{const value=await window.archon.api.call('harnesses');set({loading:false,rows:Array.isArray(value?.harnesses)?value.harnesses:[],error:''})}catch(e){set({...state,loading:false,error:ArchonGitModel.errorText(e)})}})();
  try{await pending}finally{pending=null}
 }
 const replace=row=>set({...state,rows:state.rows.map(r=>r.id===row.id?row:r)});
 const subscribe=fn=>{listeners.add(fn);return()=>listeners.delete(fn)};
 const use=()=>{const value=k.useSyncExternalStore(subscribe,()=>state);k.useEffect(()=>{void refresh()},[]);return value};
 const off=id=>{const row=state.rows.find(r=>r.id===id);return !!row&&!row.ready};
 return {refresh,replace,use,off,snapshot:()=>state};
})();
function ArchonHarnesses(){
 const {connected,say,confirm,data}=Ne();const store=ArchonHarnessStore.use();
 const [busy,setBusy]=k.useState(''),[results,setResults]=k.useState({});
 const act=async(id,label,op,payload,after)=>{
  if(busy)return;setBusy(id+':'+label);
  try{const row=await window.archon.api.call(op,{id,...payload});ArchonHarnessStore.replace(row);after?.(row)}
  catch(e){say(ArchonGitModel.errorText(e))}finally{setBusy('')}
 };
 const check=id=>act(id,'check','harnessCheck',{},row=>setResults(r=>({...r,[id]:row.ok?'Healthy'+(row.latest?` · latest ${row.latest}`:''):row.problems.join(' · ')})));
 const update=row=>confirm({title:`Update ${row.label}?`,body:`Installs ${row.package}@latest on the MiniPC with npm. New work waits until it finishes.`,target:`${row.version||'?'} → ${row.latest||'latest'}`,confirm:'Update',onConfirm:()=>act(row.id,'update','harnessUpdate',{confirm:true},next=>{setResults(r=>({...r,[row.id]:`Updated to ${next.version}`}));say(`${row.label} updated`)})});
 const opencodeModels=(data.models||[]).filter(m=>m.provider==='opencode').map(m=>m.id);
 const status=row=>row.updating?['Updating','busy']:!row.installed?['Not installed','missing']:!row.enabled?['Off','off']:['Ready','ready'];
 const fact=(label,value)=>ASn('div',{className:'ar-harness-fact'},ASn('small',null,label),ASn('span',null,value));
 const card=row=>{
  const [text,tone]=status(row),working=busy.startsWith(row.id+':');
  return ASn('article',{key:row.id,className:'ar-harness','data-tone':tone,'aria-label':row.label},
   ASn('header',null,ASn('strong',null,row.label),ASn('span',{className:'ar-harness-pill','data-tone':tone},text),
    ASn('button',{type:'button',role:'switch','aria-checked':row.enabled,'aria-label':`Use ${row.label} for new work`,className:'ar-harness-switch',disabled:!connected||working,onClick:()=>act(row.id,'toggle','harnessConfigure',{enabled:!row.enabled},next=>say(`${next.label} ${next.enabled?'turned on':'turned off'}`))},ASn('span',null))),
   ASn('p',{className:'ar-harness-note'},row.description),
   ASn('div',{className:'ar-harness-facts'},
    fact('Version',row.version?row.version+(row.update_available?` · ${row.latest} available`:''):'—'),
    fact('Signed in',row.signed_in.length?row.signed_in.join(', '):'No saved sign-ins'),
    fact('Archon sessions',row.sessions+(row.running?` · ${row.running} running`:'')),
    fact('Executable',ASn('code',null,row.executable))),
   row.id==='opencode'&&ASn('label',{className:'ar-harness-model'},ASn('small',null,'Default model'),
    ASn('select',{value:row.default_model||'','aria-label':'OpenCode default model',disabled:!connected||working,onChange:e=>act(row.id,'model','harnessConfigure',{default_model:e.target.value},next=>say(`OpenCode default: ${next.default_model||'built-in'}`))},
     ASn('option',{value:''},'Built-in default'),...[...new Set([...(row.default_model?[row.default_model]:[]),...opencodeModels])].map(id=>ASn('option',{key:id,value:id},id)))),
   ASn('div',{className:'ar-harness-actions'},
    ASn('button',{type:'button',className:'as-button as-secondary',disabled:!connected||working,onClick:()=>check(row.id)},busy===row.id+':check'?'Checking…':'Check'),
    row.can_update?ASn('button',{type:'button',className:'as-button as-secondary',disabled:!connected||working||row.running>0||!row.installed,title:row.running?'Wait for running work to finish':undefined,onClick:()=>update(row)},busy===row.id+':update'?'Updating…':row.update_available?`Update to ${row.latest}`:'Update'):ASn('span',{className:'ar-harness-muted'},'Updated by its own installer'),
    results[row.id]&&ASn('span',{className:'ar-harness-muted',role:'status'},results[row.id])));
 };
 return ASn('div',{className:'as-stack'},ASn('style',null,ARCHON_HARNESS_CSS),
  ASn(ASsection,{title:'Agent harnesses',note:'The coding agents installed on your MiniPC. A harness that is off cannot start or continue conversations until you turn it back on.'},
   !connected&&ASn('div',{className:'as-notice as-warning',role:'status'},ASicon('ph-warning-circle'),ASn('p',null,'Connect to the MiniPC to manage its agents.')),
   store.error&&ASn('div',{className:'as-notice as-warning',role:'alert'},ASicon('ph-warning-circle'),ASn('p',null,store.error)),
   store.loading&&!store.rows.length?ASn('p',{className:'ar-harness-muted'},'Loading…'):ASn('div',{className:'ar-harness-grid'},store.rows.map(card)),
   ASn('button',{type:'button',className:'as-button as-secondary',onClick:()=>void ArchonHarnessStore.refresh()},'Refresh')));
}
const ARCHON_HARNESS_CSS=`
.ar-harness-grid{display:grid;gap:12px}.ar-harness{border:1px solid var(--ar-edge);border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:10px;background:var(--ar-panel)}.ar-harness[data-tone=off],.ar-harness[data-tone=missing]{opacity:.78}.ar-harness header{display:flex;align-items:center;gap:10px}.ar-harness header strong{font-size:15px}.ar-harness-pill{font-size:10px;letter-spacing:.06em;text-transform:uppercase;padding:2px 8px;border-radius:999px;border:1px solid var(--ar-edge)}.ar-harness-pill[data-tone=ready]{color:#3fb950;border-color:currentColor}.ar-harness-pill[data-tone=off]{opacity:.7}.ar-harness-pill[data-tone=missing]{color:#f85149;border-color:currentColor}.ar-harness-pill[data-tone=busy]{color:var(--color-accent);border-color:currentColor}.ar-harness-switch{margin-inline-start:auto;width:38px;height:22px;border-radius:999px;border:1px solid var(--ar-edge);background:var(--ar-hover);position:relative;cursor:pointer;padding:0}.ar-harness-switch span{position:absolute;top:2px;inset-inline-start:2px;width:16px;height:16px;border-radius:50%;background:currentColor;opacity:.5;transition:inset-inline-start .15s}.ar-harness-switch[aria-checked=true]{background:var(--color-accent);border-color:var(--color-accent)}.ar-harness-switch[aria-checked=true] span{inset-inline-start:18px;opacity:1;background:var(--color-bg)}.ar-harness-switch:disabled{opacity:.4;cursor:default}.ar-harness-switch:focus-visible{outline:2px solid var(--color-accent);outline-offset:2px}.ar-harness-note{margin:0;font-size:12px;opacity:.7}.ar-harness-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px 16px}.ar-harness-fact{display:flex;flex-direction:column;gap:2px;min-width:0}.ar-harness-fact small,.ar-harness-model small{font-size:10px;letter-spacing:.06em;text-transform:uppercase;opacity:.55}.ar-harness-fact span{font-size:12px;overflow-wrap:anywhere}.ar-harness-fact code{font:11px var(--font-mono,monospace);direction:ltr;unicode-bidi:isolate}.ar-harness-model{display:flex;flex-direction:column;gap:4px;max-width:360px}.ar-harness-model select{padding:6px 8px;border-radius:6px;border:1px solid var(--ar-edge);background:transparent;color:inherit;font-size:12px}.ar-harness-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.ar-harness-muted{font-size:11px;opacity:.6}
`;
