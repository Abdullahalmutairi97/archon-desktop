const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {EventEmitter}=require('node:events');
const model=require('../collab-model.cjs');

// Exercise the component's actual event handlers without a DOM or a real peer service.
function mount({messages=async()=>[{role:'agent',content:'Second session'}]}={}){
 const slots=[],effects=[],peers=[],timers=new Map();let cursor=0,dirty=false,tree,timerId=0;
 const context={connected:true,settings:{serverUrl:'https://agent.test'},data:{projects:[{id:'p',title:'Project'}],sessions:[{id:'a',title:'First',projectId:'p'},{id:'b',title:'Second',projectId:'p'}]},say(){},setUi(){}};
 const transcript={sessionId:'a',messages:[{role:'agent',content:'First session'}]};
 const hooks={Fragment:Symbol('Fragment'),useState(initial){const at=cursor++;if(!(at in slots))slots[at]=typeof initial==='function'?initial():initial;return [slots[at],value=>{slots[at]=typeof value==='function'?value(slots[at]):value;dirty=true}]},useRef(initial){const at=cursor++;return slots[at]||(slots[at]={current:initial})},useEffect(callback,deps){const at=cursor++,old=slots[at];if(!old||deps.some((d,i)=>d!==old.deps[i])){slots[at]={deps,cleanup:old?.cleanup};effects.push(()=>{slots[at].cleanup?.();slots[at].cleanup=callback()})}}};
 class Peer extends EventEmitter{constructor(){super();peers.push(this)}connect(){this.connection=new EventEmitter();this.connection.close=()=>this.connection.emit('close');return this.connection}destroy(){this.destroyed=true}}
 const scope={k:hooks,Ne:()=>context,arUseTranscript:()=>transcript,K:{messages},ArchonCollabModel:model,ASn:(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity)}),window:{Peer},crypto:{randomUUID:()=> '11111111-1111-4111-8111-111111111111'},st:{copyText:async()=>{}},setTimeout:callback=>{timers.set(++timerId,callback);return timerId},clearTimeout:id=>timers.delete(id)};
 vm.createContext(scope);vm.runInContext(fs.readFileSync(require.resolve('../collab-renderer.js'),'utf8'),scope);
 function render(){let rounds=0;do{dirty=false;cursor=0;tree=scope.ArchonCollab();while(effects.length)effects.shift()();if(++rounds>20)throw Error('Render loop')}while(dirty);return tree}
 function nodes(node=tree){return node&&typeof node==='object'?[node,...(node.children||[]).flatMap(nodes)]:[]}
 const find=predicate=>nodes().find(predicate);
 function button(label){const node=find(n=>n.type==='button'&&n.children.includes(label));assert.ok(node,'Missing button '+label);return node}
 function select(label,value){const node=find(n=>n.props['aria-label']===label);assert.ok(node,'Missing field '+label);node.props.onChange({target:{value}});render()}
 async function click(label){const pending=button(label).props.onClick();render();await pending;render()}
 render();button('Share').props.onClick();render();
 return {render,find,button,select,click,peers,timers,context};
}

test('changing selection cancels a pending snapshot review',async()=>{
 let resolve;const ui=mount({messages:()=>new Promise(done=>{resolve=done})});
 ui.select('Select session','b');
 const pending=ui.button('Review snapshot').props.onClick();ui.render();
 ui.select('Select session','a');resolve([{role:'agent',content:'Second session'}]);await pending;ui.render();
 assert.equal(ui.find(n=>n.props['aria-label']==='Snapshot review'),undefined);
 assert.equal(ui.button('Review snapshot').props.disabled,false);
});

test('changing sharing type cancels a pending snapshot review',async()=>{
 let resolve;const ui=mount({messages:()=>new Promise(done=>{resolve=done})});
 ui.select('Select session','b');
 const pending=ui.button('Review snapshot').props.onClick();ui.render();
 ui.select('Share type','project');resolve([{role:'agent',content:'Second session'}]);await pending;ui.render();
 assert.equal(ui.find(n=>n.props['aria-label']==='Snapshot review'),undefined);
});

test('a cancelled project review stops fetching additional sessions',async()=>{
 let resolve;const requested=[],ui=mount({messages:id=>{requested.push(id);return id==='b'?new Promise(done=>{resolve=done}):Promise.resolve([])}});
 ui.context.data.sessions.push({id:'c',title:'Third',projectId:'p'});
 ui.select('Share type','project');ui.select('Select project','p');
 const pending=ui.button('Review snapshot').props.onClick();ui.render();
 ui.select('Share type','session');resolve([{role:'agent',content:'Second session'}]);await pending;ui.render();
 assert.deepEqual(requested,['b']);
});

test('changing selection revokes the previous peer invite',async()=>{
 const ui=mount();await ui.click('Review snapshot');await ui.click('Create peer invite');
 const peer=ui.peers[0];peer.emit('open','owner');ui.render();
 assert.ok(ui.find(n=>n.props['aria-label']==='Sharing code'));
 ui.select('Select session','b');
 assert.equal(peer.destroyed,true);
 assert.equal(ui.find(n=>n.props['aria-label']==='Sharing code'),undefined);
});

test('peer closure before receipt reports failure and releases resources',async()=>{
 const ui=mount();ui.select('Invite code','archon-peer:owner:11111111-1111-4111-8111-111111111111');
 await ui.click('Open shared content');const peer=ui.peers[0];peer.emit('open','guest');
 peer.connection.emit('close');ui.render();
 const error=ui.find(n=>n.props.role==='alert');
 assert.ok(error,'A connection closed without sending a snapshot must report failure');
 assert.match(error.children.join(''),/before.*snapshot|no snapshot/i);
 assert.equal(peer.destroyed,true);
 assert.equal(ui.timers.size,0);
});

test('a received snapshot remains available after its peer closes',async()=>{
 const ui=mount();ui.select('Invite code','archon-peer:owner:11111111-1111-4111-8111-111111111111');
 await ui.click('Open shared content');const peer=ui.peers[0];peer.emit('open','guest');
 peer.connection.emit('data',model.create('session','Shared',[{id:'s',title:'Session',messages:[{role:'agent',content:'Hello'}]}]));
 peer.connection.emit('close');ui.render();
 assert.ok(ui.find(n=>n.props['aria-label']==='Shared content'));
 assert.equal(ui.find(n=>n.props.role==='alert'),undefined);
 assert.equal(ui.timers.size,0);
});
