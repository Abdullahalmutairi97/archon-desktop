const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {patchRenderer}=require('../candidate.cjs');
const baseline=require('../baseline.json');
const archive=process.env.ARCHON_V030_ASAR;
const renderer=archive?require('@electron/asar').extractFile(archive,baseline.rendererPath).toString():'';
const patched=renderer?patchRenderer(renderer):'';
const source=patched.slice(patched.indexOf('function ASConnection(){'),patched.indexOf('function ASLanguage(){'));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}};

// Invoke the shipped settings component after candidate integration, keeping the
// two network stages independently controllable and using no real credentials.
function mount(){
 const hooks=[],effects=[],healthCalls=[],hostCalls=[];let cursor=0,dirty=true,live=true,lateUpdates=0,tree;
 const ctx={settings:{serverUrl:'https://one.example'},connected:true,latency:1,patch(){},say(){}};
 const k={useState(initial){const i=cursor++;if(!(i in hooks))hooks[i]={value:initial};return [hooks[i].value,value=>{if(!live)lateUpdates++;hooks[i].value=typeof value==='function'?value(hooks[i].value):value;dirty=true}]},useRef(value){const i=cursor++;return hooks[i]||(hooks[i]={current:value})},useEffect(callback,deps){const i=cursor++,old=hooks[i];if(!old||deps.some((v,n)=>v!==old.deps[n])){hooks[i]={deps,cleanup:old?.cleanup};effects.push(()=>{hooks[i].cleanup?.();hooks[i].cleanup=callback()})}}};
 const K={health(){const call=deferred();healthCalls.push(call);return call.promise},host(){const call=deferred();hostCalls.push(call);return call.promise}};
 const scope={k,K,Ne:()=>ctx,URL,ASn:(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity)}),ASicon:()=>null,ASsection:'section',ASrow:'row'};
 vm.createContext(scope);vm.runInContext(source,scope);
 function render(){while(dirty&&live){dirty=false;cursor=0;tree=scope.ASConnection();while(effects.length)effects.shift()()}return tree}
 const nodes=n=>n&&typeof n==='object'?[n,...n.children.flatMap(nodes)]:[];
 const button=()=>nodes(render()).find(n=>n.type==='button'&&(n.children.includes('Test connection')||n.children.includes('Testing…')));
 return {healthCalls,hostCalls,button,render,start(){return button().props.onClick()},switchServer(){ctx.settings={serverUrl:'https://two.example'};dirty=true;render()},status(){return nodes(render()).filter(n=>n.props.role==='status').map(n=>n.children.join('')).join('')},async flush(){for(let i=0;i<8;i++){await Promise.resolve();render()}},unmount(){live=false;for(const h of hooks)h.cleanup?.()},get lateUpdates(){return lateUpdates}};
}
const options={skip:!renderer};

test('switching servers during health cancels the old connection test before authorization',options,async()=>{
 const ui=mount(),pending=ui.start();ui.switchServer();
 assert.equal(ui.button().props.disabled,false,'The new server can be tested immediately');
 ui.healthCalls[0].resolve({ok:true,latencyMs:11});await pending;await ui.flush();
 assert.equal(ui.hostCalls.length,0);
 assert.equal(ui.status(),'');
});

test('late authorization from another server cannot publish success or unlock a new probe',options,async()=>{
 const ui=mount(),old=ui.start();ui.healthCalls[0].resolve({ok:true,latencyMs:11});await ui.flush();
 assert.equal(ui.hostCalls.length,1);ui.switchServer();const current=ui.start();
 ui.hostCalls[0].resolve({});await old;await ui.flush();
 assert.equal(ui.status(),'');assert.equal(ui.button().props.disabled,true);
 ui.healthCalls[1].resolve({ok:true,latencyMs:22});await ui.flush();ui.hostCalls[1].resolve({});await current;await ui.flush();
 assert.equal(ui.status(),'Authenticated connection · 22 ms');
});

test('closing settings invalidates the pending probe without late state updates',options,async()=>{
 const ui=mount(),pending=ui.start();ui.unmount();ui.healthCalls[0].resolve({ok:true,latencyMs:11});await ui.flush();for(const call of ui.hostCalls)call.resolve({});await pending;
 assert.equal(ui.hostCalls.length,0);assert.equal(ui.lateUpdates,0);
});

test('rapid duplicate test clicks perform one health and authorization probe',options,async()=>{
 const ui=mount(),click=ui.button().props.onClick,first=click(),second=click();
 assert.equal(ui.healthCalls.length,1);ui.healthCalls[0].resolve({ok:true,latencyMs:11});await ui.flush();
 assert.equal(ui.hostCalls.length,1);ui.hostCalls[0].resolve({});await Promise.all([first,second]);await ui.flush();
 assert.equal(ui.status(),'Authenticated connection · 11 ms');assert.equal(ui.button().props.disabled,false);
});

test('authorization failure reports the error and allows the current server to retry',options,async()=>{
 const ui=mount(),pending=ui.start();ui.healthCalls[0].resolve({ok:true,latencyMs:11});await ui.flush();
 ui.hostCalls[0].reject(Error('unauthorized'));await pending;await ui.flush();
 assert.match(ui.status(),/Connection failed/);assert.equal(ui.button().props.disabled,false);
});
