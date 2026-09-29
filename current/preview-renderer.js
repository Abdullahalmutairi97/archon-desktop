// Agents run on the server, so their localhost is the server's. Browser
// navigations to a loopback URL open that port through the server's preview gateway.
const ArchonPreview=(()=>{
 const loopback=new Set(['localhost','127.0.0.1','0.0.0.0','[::1]']);
 const bare=/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?([/?#]|$)/i;
 const opened=new Map();
 function target(input){
  let text=String(input||'').trim();if(bare.test(text))text='http://'+text;
  let url;try{url=new URL(text)}catch{return null}
  if(url.protocol!=='http:'||!loopback.has(url.hostname.toLowerCase()))return null;
  return {port:Number(url.port||80),path:url.pathname+url.search,hash:url.hash};
 }
 function reason(error,port){
  const message=String(error?.message||error),status=Number((message.match(/→ (\d{3})/)||[])[1]);
  if(/unauthorized/i.test(message))return 'The server rejected this device token. Check Settings → Connection.';
  if(status===404)return `Nothing is listening on localhost:${port} on the server. Start the dev server there, then try again.`;
  if(status===429)return 'Too many previews are open on the server. Close one and try again.';
  if(status===400)return `localhost:${port} cannot be previewed.`;
  if(status===503)return 'Previews are disabled because the server listens on every network address.';
  return 'Could not reach the Archon server. Check the connection in Settings.';
 }
 const escape=text=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const page=(port,message)=>`<!doctype html><meta charset="utf-8"><title>Preview unavailable</title><style>:root{color-scheme:light dark}body{font:14px/1.6 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:Canvas;color:CanvasText}main{max-width:420px;padding:24px}h1{font-size:16px}code{font-family:ui-monospace,monospace}</style><main><h1>Preview of <code>localhost:${port}</code> unavailable</h1><p>${escape(message)}</p></main>`;
 async function open(t){
  const {preview}=await window.archon.api.call('previewOpen',{port:t.port});
  opened.set(preview.origin,{port:t.port,key:preview.query_key,secret:preview.secret});
  const url=new URL(t.path,preview.origin);url.searchParams.set(preview.query_key,preview.secret);url.hash=t.hash;
  return url.href;
 }
 async function navigate(id,input){
  const t=id==='browser'?target(input):null;
  if(!t)return window.archon?.web.navigate(id,input);
  try{return window.archon?.web.navigate(id,await open(t))}
  catch(error){return window.archon?.web.renderHtml(id,page(t.port,reason(error,t.port)),'preview-unavailable')}
 }
 async function openExternal(input){
  const t=target(input);
  if(!t)return window.archon?.openExternal(input);
  try{return window.archon?.openExternal(await open(t))}catch{}
 }
 function lookup(value){try{const url=new URL(value),hit=opened.get(url.origin);return hit?{url,hit}:null}catch{return null}}
 function original(value){const found=lookup(value);if(!found)return value;const {url,hit}=found;url.searchParams.delete(hit.key);return `http://localhost:${hit.port}${url.pathname}${url.search}${url.hash}`}
 function external(value){const found=lookup(value);if(!found)return value;const {url,hit}=found;url.searchParams.set(hit.key,hit.secret);return url.href}
 return {target,navigate,openExternal,original,external};
})();
