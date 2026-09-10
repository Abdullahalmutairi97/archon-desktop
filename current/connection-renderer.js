function ArchonDeviceToken(){
 const {refresh,settings}=Ne();const [token,setToken]=k.useState(''),[present,setPresent]=k.useState(null),[busy,setBusy]=k.useState(false),[message,setMessage]=k.useState('');
 k.useEffect(()=>{let live=true;setToken('');window.archon?.token?.present().then(v=>{if(live)setPresent(v)},()=>{if(live)setMessage('Could not check stored credentials.')});return()=>{live=false}},[settings.serverUrl]);
 const save=async()=>{setBusy(true);setMessage('');try{if(!window.archon?.token?.write)throw Error();await window.archon.token.write(token.trim());setToken('');setPresent(true);setMessage('Device token saved. Test the connection above.');await refresh(true)}catch{setMessage('Could not save the token. Use the desktop app and retry.')}finally{setBusy(false)}};
 return ASn(ASsection,{title:'Device token',note:'Enter your existing Archon device token here. It is stored by the desktop app and is never included in collaboration shares.'},
 ASn('div',{className:'as-input-action'},ASn('input',{type:'password','aria-label':'Device token',autoComplete:'off',value:token,onChange:e=>setToken(e.target.value),placeholder:present?'A token is already stored':'Paste device token',disabled:busy}),ASn('button',{type:'button',className:'as-button',disabled:busy||!token.trim(),onClick:save},busy?'Saving…':'Save token')),
 ASn('p',{role:'status',className:'as-muted'},message||(present===null?'Checking credentials…':present?'Device token stored':'No device token stored')));
}
