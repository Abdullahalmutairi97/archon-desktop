const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {patchMain}=require('../main-ops-patch.cjs');

const fixture=['var api = new ArchonApi();','import_electron3.ipcMain.handle("api:call", (_e, op, payload) => api.call(op, payload ?? {}));'].join('\n');

function load(respond){
 const seen=[],bridge=[];let handler;
 const api={baseUrl:'http://server:9700',headers:json=>({json}),qs:params=>{const out=new URLSearchParams();for(const [k,v] of Object.entries(params))if(v!==null&&v!==undefined&&v!=='')out.set(k,String(v));const s=out.toString();return s?'?'+s:''},call:async(op,p)=>{bridge.push([op,p]);return 'bridge'}};
 const fetch=async(url,init)=>{seen.push({url,method:init.method,body:init.body?JSON.parse(init.body):undefined});const [status,body]=respond(url,init);return {status,ok:status<300,text:async()=>body===undefined?'':JSON.stringify(body)}};
 vm.runInNewContext(patchMain(fixture).replace('var api = new ArchonApi();',''),{api,fetch,AbortSignal,URLSearchParams,import_electron3:{ipcMain:{handle:(name,fn)=>{assert.equal(name,'api:call');handler=fn}}}});
 return {call:(op,p)=>handler(null,op,p),seen,bridge};
}

test('preview and Git operations reach their routes; everything else stays on the original bridge',async()=>{
 const h=load(()=>[200,{ok:true}]);
 await h.call('previewOpen',{port:'5173'});
 await h.call('gitStatus',{path:'projects/app'});
 await h.call('gitDiff',{path:'p',scope:'compare',base:'origin/main',ref:'',file:'a b.ts'});
 await h.call('gitLog',{path:'p',limit:20});
 await h.call('gitStage',{path:'p',files:['a.ts',2]});
 await h.call('gitDiscard',{path:'p',files:['a.ts'],confirm:'yes'});
 await h.call('gitPush',{path:'p',confirm:true});
 await h.call('gitCommit',{path:'p',message:'Fix'});
 assert.equal(await h.call('sessions',{}),'bridge');
 assert.equal(await h.call('toString',{}),'bridge');
 assert.deepEqual(JSON.parse(JSON.stringify(h.seen)),[
  {url:'http://server:9700/api/previews',method:'POST',body:{port:5173}},
  {url:'http://server:9700/api/git/status?path=projects%2Fapp',method:'GET'},
  {url:'http://server:9700/api/git/diff?path=p&scope=compare&base=origin%2Fmain&file=a+b.ts',method:'GET'},
  {url:'http://server:9700/api/git/log?path=p&limit=20',method:'GET'},
  {url:'http://server:9700/api/git/stage',method:'POST',body:{path:'p',files:['a.ts','2']}},
  {url:'http://server:9700/api/git/discard',method:'POST',body:{path:'p',files:['a.ts'],confirm:false}},
  {url:'http://server:9700/api/git/push',method:'POST',body:{path:'p',confirm:true}},
  {url:'http://server:9700/api/git/commit',method:'POST',body:{path:'p',message:'Fix'}},
 ]);
 assert.deepEqual(JSON.parse(JSON.stringify(h.bridge)),[['sessions',{}],['toString',{}]]);
});

test('errors keep the server detail and a rejected token reads as unauthorized',async()=>{
 const h=load(url=>url.includes('commit')?[409,{detail:'lint failed: fix app.py'}]:url.includes('status')?[401,{detail:'Unauthorized'}]:[404,{detail:'Nothing is listening'}]);
 await assert.rejects(h.call('gitCommit',{path:'p',message:'x'}),/POST \/api\/git\/commit → 409: lint failed: fix app.py/);
 await assert.rejects(h.call('gitStatus',{path:'p'}),/unauthorized/);
 await assert.rejects(h.call('previewOpen',{port:1}),/→ 404: Nothing is listening/);
});

test('patch fails closed on missing or duplicated anchors',()=>{
 assert.throws(()=>patchMain('var api = new ArchonApi();'),/Extra API routing/);
 assert.throws(()=>patchMain(fixture+'\n'+fixture),/Extra operations/);
});
