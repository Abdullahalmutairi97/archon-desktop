function ArchonDeviceToken(){
 const {refresh,settings}=Ne();const [token,setToken]=k.useState(''),[present,setPresent]=k.useState(null),[busy,setBusy]=k.useState(false),[message,setMessage]=k.useState('');
 const lifetime=k.useRef(null),pending=k.useRef(null);
 if(lifetime.current?.server!==settings.serverUrl)lifetime.current={server:settings.serverUrl,live:false,revision:0};
 const scope=lifetime.current,current=revision=>scope.live&&lifetime.current===scope&&scope.revision===revision;
 k.useEffect(()=>{
  scope.live=true;const revision=++scope.revision;
  setToken('');setPresent(null);setMessage('');setBusy(!!pending.current);
  (async()=>{
   try{
    // The desktop stores one global token. If the server changed during a write,
    // check presence after that write settles without replaying its old refresh.
    if(pending.current)await pending.current.catch(()=>{});
    if(!current(revision))return;
    const bridge=window.archon?.token;
    if(typeof bridge?.present!=='function')throw Error();
    const value=await bridge.present();
    if(current(revision))setPresent(value===true);
   }catch{if(current(revision))setMessage('Could not check stored credentials. Use the desktop app and retry.')}
   finally{if(current(revision))setBusy(false)}
  })();
  return()=>{scope.live=false;scope.revision++};
 },[scope]);
 const save=async()=>{
  const value=token.trim();if(!value||pending.current||!scope.live||lifetime.current!==scope)return;
  const revision=++scope.revision;setBusy(true);setMessage('');
  try{
   const bridge=window.archon?.token;if(typeof bridge?.write!=='function')throw Error();
   const operation=Promise.resolve().then(()=>bridge.write(value));pending.current=operation;
   try{await operation}finally{if(pending.current===operation)pending.current=null}
   if(!current(revision))return;
   setToken('');setPresent(true);setBusy(false);setMessage('Device token saved. Test the connection above.');
   try{await refresh(true)}catch{if(current(revision))setMessage('Device token saved, but the connection could not refresh. Test the connection above.')}
  }catch{if(current(revision))setMessage('Could not save the token. Use the desktop app and retry.')}
  finally{if(current(revision))setBusy(false)}
 };
 return ASn(ASsection,{title:'Device token',note:'Enter your existing Archon device token here. It is stored by the desktop app and is never included in collaboration shares.'},
 ASn('div',{className:'as-input-action'},ASn('input',{type:'password','aria-label':'Device token',autoComplete:'off',value:token,onChange:e=>setToken(e.target.value),placeholder:present?'A token is already stored':'Paste device token',disabled:busy}),ASn('button',{type:'button',className:'as-button',disabled:busy||!token.trim(),onClick:save},busy?'Saving…':'Save token')),
 ASn('p',{role:'status',className:'as-muted'},message||(present===null?'Checking credentials…':present?'Device token stored':'No device token stored')));
}
