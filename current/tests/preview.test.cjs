const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');

function harness(call){
 const calls=[],nav=[],html=[];
 const window={archon:{openExternal:url=>nav.push({id:'external',url}),api:{call:async(op,payload)=>{calls.push({op,payload});return call(op,payload)}},web:{navigate:(id,url)=>nav.push({id,url}),renderHtml:(id,body,key)=>html.push({id,body,key})}}};
 const context=vm.createContext({window,URL});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../preview-renderer.js'),'utf8')+'\nthis.P=ArchonPreview;',context);
 return {P:context.P,calls,nav,html};
}
const opened={preview:{id:'abc',origin:'http://100.64.0.1:41234',port:41234,upstream_port:5173,secret:'s3cret',query_key:'archon_preview'}};

test('only plain-http loopback addresses are treated as server previews',()=>{
 const {P}=harness(()=>opened);
 assert.deepEqual({...P.target('localhost:5173')},{port:5173,path:'/',hash:''});
 assert.deepEqual({...P.target('http://127.0.0.1:3000/a/b?x=1#top')},{port:3000,path:'/a/b?x=1',hash:'#top'});
 assert.equal(P.target('http://[::1]:8080/').port,8080);
 assert.equal(P.target('0.0.0.0:4000/docs').port,4000);
 assert.equal(P.target('http://localhost/').port,80);
 for(const other of ['https://localhost:5173','https://example.com','http://100.64.0.1:5173','localhost.example.com:80','search words','file:///etc/passwd'])assert.equal(P.target(other),null,other);
});

test('a loopback link opens through the server gateway with its path, query and hash',async()=>{
 const h=harness(()=>opened);
 await h.P.navigate('browser','http://localhost:5173/app/?tab=2#main');
 assert.deepEqual(JSON.parse(JSON.stringify(h.calls)),[{op:'previewOpen',payload:{port:5173}}]);
 assert.equal(h.nav.length,1);
 const url=new URL(h.nav[0].url);
 assert.equal(url.origin,'http://100.64.0.1:41234');
 assert.equal(url.pathname,'/app/');assert.equal(url.searchParams.get('tab'),'2');
 assert.equal(url.searchParams.get('archon_preview'),'s3cret');assert.equal(url.hash,'#main');
});

test('other addresses and other surfaces navigate unchanged',async()=>{
 const h=harness(()=>opened);
 await h.P.navigate('browser','https://github.com');await h.P.navigate('design','http://localhost:5173');
 assert.deepEqual(h.nav.map(x=>({...x})),[{id:'browser',url:'https://github.com'},{id:'design',url:'http://localhost:5173'}]);
 assert.equal(h.calls.length,0);
});

test('the address bar, Ask Archon and system browser see the right URL',async()=>{
 const h=harness(()=>opened);await h.P.navigate('browser','localhost:5173/login');
 assert.equal(h.P.original('http://100.64.0.1:41234/dashboard?x=1#a'),'http://localhost:5173/dashboard?x=1#a');
 assert.equal(h.P.original('http://100.64.0.1:41234/?archon_preview=s3cret'),'http://localhost:5173/');
 assert.equal(h.P.external('http://100.64.0.1:41234/dashboard'),'http://100.64.0.1:41234/dashboard?archon_preview=s3cret');
 assert.equal(h.P.original('https://github.com/x'),'https://github.com/x');
 assert.equal(h.P.external('https://github.com/x'),'https://github.com/x');
});

test('a failed preview explains the cause instead of loading this PC\'s localhost',async()=>{
 const cases=[['Error: POST /api/previews → 404','Nothing is listening on localhost:5173'],['Error: unauthorized: the device token was rejected','rejected this device token'],['Error: POST /api/previews → 429','Too many previews'],['fetch failed','Could not reach the Archon server']];
 for(const [message,expected] of cases){
  const h=harness(()=>{throw Error(message)});
  await h.P.navigate('browser','http://localhost:5173/<b>');
  assert.equal(h.nav.length,0);assert.equal(h.html.length,1);
  assert.equal(h.html[0].id,'browser');assert.ok(h.html[0].body.includes(expected),message);
  assert.ok(!h.html[0].body.includes('<b>'));
 }
});

test('loopback links opened outside the app also go through the server',async()=>{
 const h=harness(()=>opened);
 await h.P.openExternal('http://localhost:5173/docs');await h.P.openExternal('https://github.com');
 assert.equal(h.nav[0].id,'external');assert.equal(new URL(h.nav[0].url).origin,'http://100.64.0.1:41234');
 assert.equal(new URL(h.nav[0].url).searchParams.get('archon_preview'),'s3cret');
 assert.equal(h.nav[1].url,'https://github.com');
 const failed=harness(()=>{throw Error('POST /api/previews → 404')});await failed.P.openExternal('http://localhost:1/');
 assert.equal(failed.nav.length,0);
});
