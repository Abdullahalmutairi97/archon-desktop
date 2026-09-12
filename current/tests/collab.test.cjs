const {test}=require('node:test');
const assert=require('node:assert/strict');
const C=require('../collab-model.cjs');
test('shares complete selected sessions but never tool or reasoning records',()=>{
 const p=C.create('session','Test',[{id:'s',title:'Hello',messages:[{role:'user',content:'Hi'},{role:'agent',content:'Hello 🌍'},{role:'agent',nativeKind:'thinking',content:'private'}]}]);
 assert.equal(p.sessions[0].messages.length,2);assert.equal(p.sessions[0].messages[0].role,'user');
 assert.deepEqual(C.parse(C.encode(p)),p);
});
test('rejects empty shares, malformed envelopes and oversized input',()=>{
 assert.throws(()=>C.create('project','Empty',[]),/session/i);
 for(const input of ['%','archon-snapshot:bad','#archon-share=%GG','x'.repeat(C.MAX*2)])assert.throws(()=>C.parse(input));
 assert.throws(()=>C.validate({type:'archon-collab',version:2,kind:'session',sessions:[{}]}));
});
test('project snapshot keeps all selected sessions and strips arbitrary fields',()=>{
 const p=C.create('project','Project',[{id:'1',title:'One',token:'secret',messages:[{role:'agent',content:'code'}]},{id:'2',title:'Two',messages:[{role:'user',content:'Question'}]}]);
 assert.equal(p.sessions.length,2);assert.equal(JSON.stringify(p).includes('secret'),false);
});
test('snapshot size limit uses UTF-8 bytes and every accepted snapshot code can reopen',()=>{
 const snapshot=text=>({type:'archon-collab',version:2,kind:'session',title:'Test',sessions:[{id:'s',title:'Session',messages:[{role:'agent',content:text}]}]});
 const oversized=snapshot('界'.repeat(Math.floor(C.MAX/2)));
 assert.ok(JSON.stringify(oversized).length<C.MAX);
 assert.throws(()=>C.validate(oversized),/oversized/i);
 const accepted=C.validate(snapshot('界'.repeat(Math.floor(C.MAX/3)-100)));
 assert.deepEqual(C.parse(C.encode(accepted)),accepted);
});
test('rejects sparse session and message arrays before they reach the viewer',()=>{
 const envelope={type:'archon-collab',version:2,kind:'session',title:'Test'};
 assert.throws(()=>C.validate({...envelope,sessions:Array(1)}),/Invalid/i);
 assert.throws(()=>C.validate({...envelope,sessions:[{id:'s',title:'Session',messages:Array(1)}]}),/Invalid/i);
});
