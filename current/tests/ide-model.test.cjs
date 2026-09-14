const {test}=require('node:test');
const assert=require('node:assert/strict');
const {collectArtifacts, Workspace}=require('../ide-model.cjs');
const message=(content, extra={})=>({id:'reply',role:'agent',content,...extra});
test('artifacts retain exact code, stable ids, and streaming fences',()=>{
 const prefix=[message('User code', {role:'user'})];
 const a=collectArtifacts([...prefix,message('```python filename="app.py"\nprint(1)\n\n```')],'one','/project');
 assert.equal(a[0].content,'print(1)\n');assert.equal(a[0].label,'app.py');
 assert.equal(collectArtifacts([message('```python filename="app.py"\nprint(12)',{streaming:true})],'one','/project')[0].id,a[0].id);
 assert.notEqual(collectArtifacts([message('```python\nx\n```')],'two','/project')[0].id,a[0].id);
 assert.equal(collectArtifacts([message('```js\nx',{streaming:false})],'one','/project').length,0);
});
test('extracts referenced files, native writes and patches; excludes reasoning and URLs',()=>{
 const items=collectArtifacts([message('See [code](src/app.ts:12) and `src/util.ts`. https://x.test/a.js'),message('write_file\n'+JSON.stringify({path:'src/new.ts',content:'const x=1;'}),{id:'tool',nativeKind:'tool'}),message('```js\nsecret\n```',{id:'thinking',nativeKind:'thinking'}),message('apply_patch\n*** Begin Patch\n*** Update File: src/other.ts\n@@\n+code\n*** End Patch',{id:'patch',nativeKind:'tool'})],'one','/project');
 assert.deepEqual(items.filter(x=>x.kind==='file').map(x=>x.path),['/project/src/app.ts','/project/src/util.ts','/project/src/new.ts','/project/src/other.ts']);
 assert.ok(!items.some(x=>x.content==='secret'));assert.ok(!items.some(x=>x.path?.includes('https:')));
});
test('does not promote commands or control directories to agent code',()=>{
 const items=collectArtifacts([message('Ran `python3 hello.py`, checked `.git`, and reviewed `AGENTS.md`; source is in `src/hello.py`.')],'one','/project');
 assert.deepEqual(items.filter(x=>x.kind==='file').map(x=>x.path),['/project/src/hello.py']);
});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{resolve,promise}};
test('files stay read-only until successful complete read; errors retry; protected entries never read',async()=>{
 let calls=0;const w=new Workspace({readFileWindow:async()=>{calls++;if(calls===1)throw Error('no');return{content:'ok',truncated:true}},writeFile:async()=>assert.fail('write')});
 await w.openFile('/a',{prot:true});assert.equal(calls,0);
 await w.openFile('/b');assert.ok(w.snapshot().docs['/b'].error);w.edit('/b','bad');assert.equal(w.snapshot().docs['/b'].text,'');
 await w.openFile('/b');assert.equal(calls,2);assert.equal(w.snapshot().docs['/b'].readOnly,true);await w.save('/b');
});
test('saving preserves edits made during a write and detects external changes',async()=>{
 let disk='original';const write=deferred();const api={readFileWindow:async()=>({content:disk}),writeFile:async(p,t)=>{await write.promise;disk=t}};const w=new Workspace(api);
 await w.openFile('/a');w.edit('/a','first');const pending=w.save('/a');await new Promise(r=>setImmediate(r));w.edit('/a','second');write.resolve();await pending;
 assert.equal(w.snapshot().docs['/a'].text,'second');assert.equal(w.isDirty('/a'),true);
 disk='agent changed';await w.save('/a');assert.match(w.snapshot().docs['/a'].error,/changed/);assert.equal(disk,'agent changed');await w.openFile('/a');assert.equal(w.snapshot().docs['/a'].text,'second');
 assert.equal(w.close('/a'),false);assert.equal(w.close('/a',true),true);
});
test('closing last active tab selects its neighbour and closing during read cannot resurrect it',async()=>{
 const d=deferred();const w=new Workspace({readFileWindow:p=>p==='/slow'?d.promise:Promise.resolve({content:p})});
 await w.openFile('/a');await w.openFile('/b');w.close('/b');assert.equal(w.snapshot().active,'/a');
 const pending=w.openFile('/slow');w.close('/slow');d.resolve({content:'late'});await pending;assert.equal(w.snapshot().docs['/slow'],undefined);
});

test('stream updates open snippets without overwriting editable files',async()=>{
 const w=new Workspace({readFileWindow:async()=>({content:'file'})});
 const snippet={id:'snippet:a',kind:'snippet',content:'first',streaming:true};w.openSnippet(snippet);
 await w.openFile('/a');w.edit('/a','draft');w.syncSnippets([{...snippet,content:'finished',streaming:false}]);
 assert.equal(w.snapshot().docs['snippet:a'].text,'finished');assert.equal(w.snapshot().docs['/a'].text,'draft');assert.equal(w.snapshot().active,'/a');
});

test('a pending save cannot be closed or reloaded, including a previously confirmed discard',async()=>{
 let disk='original',reads=0;const preflight=deferred();
 const w=new Workspace({readFileWindow:async()=>{reads++;if(reads===2)await preflight.promise;return{content:disk}},writeFile:async(path,text)=>{disk=text}});
 await w.openFile('/a');w.edit('/a','saved edit');const saving=w.save('/a');
 assert.equal(w.close('/a',true),false);
 await w.openFile('/a',{},true);
 assert.equal(reads,2);assert.equal(w.snapshot().docs['/a'].text,'saved edit');assert.equal(w.snapshot().docs['/a'].saving,true);
 w.edit('/a','newer draft');preflight.resolve();await saving;
 assert.equal(disk,'saved edit');assert.equal(w.snapshot().docs['/a'].text,'newer draft');assert.equal(w.isDirty('/a'),true);
 assert.equal(w.close('/a',true),true);
});

test('failed reload retains the current text and dirty state for retry',async()=>{
 let fail=false;const w=new Workspace({readFileWindow:async()=>{if(fail)throw Error('offline');return{content:'original'}}});
 await w.openFile('/a');w.edit('/a','draft');fail=true;await w.openFile('/a',{},true);
 const doc=w.snapshot().docs['/a'];assert.equal(doc.text,'draft');assert.equal(doc.base,'original');assert.equal(w.isDirty('/a'),true);assert.match(doc.error,/Could not read/);
 fail=false;await w.openFile('/a',{},true);assert.equal(w.snapshot().docs['/a'].text,'original');assert.equal(w.isDirty('/a'),false);
});

test('malformed file responses never become editable documents or crash the editor',async()=>{
 for(const response of [{}, {content:null}, {content:12}, null]){
  const w=new Workspace({readFileWindow:async()=>response,writeFile:async()=>assert.fail('write')});
  await w.openFile('/a');const doc=w.snapshot().docs['/a'];assert.equal(typeof doc.text,'string');assert.equal(doc.readOnly,true);assert.ok(doc.error);
  w.edit('/a','overwrite');await w.save('/a');
 }
});

test('a draft remains protected while reload is pending and cannot start a concurrent save',async()=>{
 const reload=deferred();let reads=0;const w=new Workspace({readFileWindow:async()=>++reads===1?{content:'original'}:reload.promise,writeFile:async()=>assert.fail('write')});
 await w.openFile('/a');w.edit('/a','draft');const pending=w.openFile('/a',{},true);
 assert.equal(w.isDirty('/a'),true);assert.equal(w.close('/a'),false);w.edit('/a','ignored');assert.equal(w.snapshot().docs['/a'].text,'draft');
 await w.save('/a');assert.equal(reads,2);assert.equal(w.snapshot().docs['/a'].saving,undefined);
 reload.resolve({content:'updated on disk'});await pending;assert.equal(w.snapshot().docs['/a'].text,'updated on disk');assert.equal(w.isDirty('/a'),false);
});
