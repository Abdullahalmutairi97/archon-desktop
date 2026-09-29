// Read-only sharing: only explicitly selected transcripts cross the peer channel.
function arLoadPeer(){
 if(window.Peer)return Promise.resolve(window.Peer);
 if(window.__archonPeerPromise)return window.__archonPeerPromise;
 window.__archonPeerPromise=new Promise((resolve,reject)=>{
  const script=document.createElement('script');script.src='./peerjs.min.js';
  const timer=setTimeout(()=>{script.remove();window.__archonPeerPromise=null;reject(Error('Sharing library timed out. Retry.'))},10000);
  script.onload=()=>{clearTimeout(timer);if(window.Peer)resolve(window.Peer);else{window.__archonPeerPromise=null;reject(Error('Sharing library unavailable.'))}};
  script.onerror=()=>{clearTimeout(timer);script.remove();window.__archonPeerPromise=null;reject(Error('Sharing library unavailable. Retry or use a snapshot code.'))};
  document.head.append(script);
 });return window.__archonPeerPromise;
}
function ArchonCollab(){
 const {data,settings,say,connected,setUi,ui}=Ne();
 const transcript=arUseTranscript();
 // The title bar's Share button opens this dialog by setting ui.collabOpen.
 const open=!!ui?.collabOpen;
 const [kind,setKind]=k.useState('session'),[selection,setSelection]=k.useState(''),[status,setStatus]=k.useState('Ready'),[error,setError]=k.useState(''),[invite,setInvite]=k.useState(''),[input,setInput]=k.useState(''),[shared,setShared]=k.useState(null),[review,setReview]=k.useState(null),[sessionIndex,setSessionIndex]=k.useState(0),[busy,setBusy]=k.useState(false);
 // Native web surfaces sit above renderer dialogs; update their covered state
 // in the same event that opens or closes this dialog.
 const show=value=>{setUi(value?{bench:null,collabOpen:true}:{collabOpen:false})};
 k.useEffect(()=>()=>setUi({collabOpen:false}),[setUi]);
 const lifetime=k.useRef({generation:0,peer:null,timer:null,connections:[]});
 const stop=()=>{const life=lifetime.current;life.generation++;clearTimeout(life.timer);life.connections.forEach(c=>c.close());life.connections=[];life.peer?.destroy();life.peer=null;setBusy(false);setInvite('');setStatus('Stopped')};
 const changeSelection=(value,isKind=false)=>{stop();setReview(null);setError('');setSessionIndex(0);if(isKind)setKind(value);else setSelection(value)};
 k.useEffect(()=>()=>{const l=lifetime.current;l.generation++;clearTimeout(l.timer);l.peer?.destroy()},[]);
 k.useEffect(()=>{stop();setReview(null);setShared(null);setSelection('');setError('')},[settings.serverUrl]);
 const choices=kind==='session'?data.sessions:data.projects;
 k.useEffect(()=>{setSelection(kind==='session'&&transcript.sessionId?transcript.sessionId:'');setReview(null)},[kind]);
 const fail=e=>{setError(e.message||'Sharing failed');setBusy(false)};
 const prepare=async()=>{
  stop();setError('');setReview(null);setBusy(true);const generation=lifetime.current.generation;
  try{
   if(!connected)throw Error('Connect to your agent server first.');
   const selected=choices.find(x=>x.id===selection);if(!selected)throw Error('Choose what to share first.');
   const sessions=kind==='session'?[selected]:data.sessions.filter(s=>s.projectId===selected.id);
   if(sessions.length>100)throw Error('Share individual sessions from this large project.');
   const collected=[];
   for(const session of sessions){
    if(generation!==lifetime.current.generation)return;
    const messages=session.id===transcript.sessionId?transcript.messages:await K.messages(session.id);
    if(generation!==lifetime.current.generation)return;
    collected.push({id:session.id,title:session.title,messages});
   }
   if(generation!==lifetime.current.generation)return;
   setReview(ArchonCollabModel.create(kind,selected.title||selected.name||'Project',collected));
   setStatus('Review the snapshot below, then choose how to share it.');
  }catch(e){if(generation===lifetime.current.generation)fail(e)}
  finally{if(generation===lifetime.current.generation)setBusy(false)}
 };
 const copy=async text=>{try{await st.copyText(text);say('Sharing code copied')}catch{setError('Copy failed. Select and copy the code manually.')}};
 const start=async()=>{
  stop();setError('');setBusy(true);setStatus('Connecting to sharing service…');
  const life=lifetime.current,generation=life.generation;
  try{
   const Peer=await arLoadPeer();if(generation!==life.generation)return;
   const peer=new Peer();life.peer=peer;
   const secret=crypto.randomUUID();
   const current=()=>generation===life.generation;
   const failed=e=>{if(!current())return;stop();fail(e);setStatus('Could not connect. Retry or explicitly create a snapshot code.')};
   life.timer=setTimeout(()=>failed(Error('Peer connection timed out.')),20000);
   peer.on('error',failed);
   peer.on('open',id=>{if(!current())return;clearTimeout(life.timer);setInvite('archon-peer:'+id+':'+secret);setBusy(false);setStatus('Sharing snapshot · keep Archon open')});
   peer.on('disconnected',()=>failed(Error('Sharing service disconnected. Create a new invite.')));
   peer.on('connection',conn=>{
    if(!current()||conn.metadata?.secret!==secret){conn.close();return}
    life.connections.push(conn);
    conn.on('open',()=>{if(current()){conn.send(review);setStatus('Snapshot sent to your friend')}});
    conn.on('error',failed);
   });
  }catch(e){if(generation===life.generation){stop();fail(e)}}
 };
 const join=async()=>{
  stop();setError('');setShared(null);setSessionIndex(0);
  const raw=input.trim();
  if(raw.startsWith('archon-snapshot:')){try{setShared(ArchonCollabModel.parse(raw));setStatus('Snapshot opened')}catch(e){fail(e)}return}
  const match=/^archon-peer:([a-zA-Z0-9_-]{1,100}):([a-f0-9-]{36})$/.exec(raw);
  if(!match){fail(Error('Paste a valid Archon sharing code. Old preview links are unsupported; ask for a new code.'));return}
  setBusy(true);setStatus('Connecting to your friend…');const life=lifetime.current,generation=life.generation;
  try{
   const Peer=await arLoadPeer();if(generation!==life.generation)return;
   const peer=new Peer();life.peer=peer;
   const failed=e=>{if(generation!==life.generation)return;stop();fail(e)};
   life.timer=setTimeout(()=>failed(Error('No snapshot received. Ask your friend to keep Archon open and create a fresh code.')),20000);
   peer.on('error',failed);
   peer.on('open',()=>{
    if(generation!==life.generation)return;
    const conn=peer.connect(match[1],{reliable:true,metadata:{secret:match[2]}});life.connections.push(conn);let received=false;
    conn.on('error',failed);
    conn.on('data',value=>{if(generation!==life.generation)return;try{const p=ArchonCollabModel.validate(value);received=true;clearTimeout(life.timer);setShared(p);setBusy(false);setStatus('Snapshot received')}catch(e){failed(e)}});
    conn.on('close',()=>{if(generation!==life.generation)return;if(!received){failed(Error('Your friend disconnected before a snapshot was received. Ask for a fresh code.'));return}stop();setStatus('Peer disconnected · received snapshot remains available')});
   });
  }catch(e){if(generation===life.generation){stop();fail(e)}}
 };
 const button=(text,onClick,disabled=false)=>ASn('button',{type:'button',className:'btn btn-secondary',onClick,disabled},text);
 const view=(p,isReview)=>ASn('section',{className:'ar-collab-content','aria-label':isReview?'Snapshot review':'Shared content'},
  ASn('strong',null,p.title+' · '+p.sessions.length+' session(s)'),
  ASn('select',{'aria-label':isReview?'Review session':'Shared session',value:Math.min(sessionIndex,p.sessions.length-1),onChange:e=>setSessionIndex(Number(e.target.value))},p.sessions.map((s,i)=>ASn('option',{key:s.id,value:i},s.title))),
  p.sessions[Math.min(sessionIndex,p.sessions.length-1)].messages.map((m,i)=>ASn('article',{key:i},ASn('strong',null,m.role==='user'?'You':'Agent'),ASn('pre',null,m.content))));
 return ASn(k.Fragment,null,
  ASn('style',null,ARCHON_COLLAB_CSS),
  open&&ASn('div',{className:'ar-collab-backdrop',onKeyDown:e=>{if(e.key==='Escape')show(false)}},
   ASn('section',{className:'ar-collab-card',role:'dialog','aria-modal':true,'aria-label':'Collaboration'},
    ASn('header',null,ASn('strong',null,'Share with a friend'),button('Close',()=>show(false))),
    ASn('p',null,'Share a read-only snapshot of conversations and agent code. Project sharing includes its listed sessions; files, live editing and agent control are not included.'),
    ASn('div',{className:'ar-collab-row'},ASn('select',{'aria-label':'Share type',value:kind,onChange:e=>changeSelection(e.target.value,true)},ASn('option',{value:'session'},'Session'),ASn('option',{value:'project'},'Project')),
     ASn('select',{'aria-label':'Select '+kind,value:selection,onChange:e=>changeSelection(e.target.value)},ASn('option',{value:''},'Choose '+kind),choices.map(s=>ASn('option',{key:s.id,value:s.id},s.title||s.name))),
     button('Review snapshot',prepare,busy||!connected||!selection)),
    review&&ASn(k.Fragment,null,view(review,true),ASn('p',null,'Only the content shown above is shared. Anyone with a sharing code can read it. Snapshot copies cannot be revoked.'),
     ASn('div',{className:'ar-collab-row'},button('Create peer invite',start,busy),button('Create snapshot code',()=>{stop();setInvite(ArchonCollabModel.encode(review));setStatus('Snapshot code ready · copy it to your friend')},busy))),
    invite&&ASn('div',{className:'ar-collab-row'},ASn('textarea',{'aria-label':'Sharing code',readOnly:true,value:invite}),button('Copy code',()=>copy(invite))),
    (invite||busy||lifetime.current.peer)&&button('Stop sharing',stop),
    ASn('hr'),
    ASn('label',null,'Join a share',ASn('textarea',{'aria-label':'Invite code',value:input,onChange:e=>setInput(e.target.value),placeholder:'Paste an Archon sharing code'})),
    button('Open shared content',join,busy||!input.trim()),
    error&&ASn('p',{role:'alert'},error),ASn('p',{role:'status'},status),
    shared&&view(shared,false)
   )));
}
const ARCHON_COLLAB_CSS=`
.ar-collab-backdrop{position:fixed;inset:0;background:#0006;z-index:50;display:flex;align-items:center;justify-content:center;padding:20px}
.ar-collab-card{width:min(720px,95vw);max-height:90vh;overflow:auto;padding:20px;border:1px solid var(--ar-edge);border-radius:10px;background:var(--color-surface,#191919);color:var(--color-text);font-size:12px}
.ar-collab-card header,.ar-collab-row{display:flex;gap:8px;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap}
.ar-collab-card p{line-height:1.5;opacity:.8}.ar-collab-card select,.ar-collab-card textarea{background:var(--color-bg,#111);color:inherit;border:1px solid var(--ar-edge);padding:8px;min-width:0;border-radius:5px}
.ar-collab-card textarea{display:block;width:100%;box-sizing:border-box;resize:vertical}.ar-collab-card select{max-width:100%}
.ar-collab-content{max-height:300px;overflow:auto;border:1px solid var(--ar-edge);padding:12px;border-radius:6px}.ar-collab-content select{display:block;margin:10px 0}
.ar-collab-content pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 monospace}.ar-collab-content article{border-top:1px solid var(--ar-edge);padding-top:10px}.ar-collab-card [role=alert]{color:#ff9c9c}
`;
