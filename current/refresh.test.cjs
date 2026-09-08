const vm=require('node:vm'),fs=require('node:fs'),assert=require('node:assert/strict');
const code=fs.readFileSync(__dirname+'/refresh.js','utf8');
function render(props){const updates=[],messages=[];const ctx={k:{useState:()=>[false,v=>updates.push(v)],useRef:v=>({current:v})},Ne:()=>({say:m=>messages.push(m)}),r:{jsx:(tag,props)=>({tag,props}),jsxs:(tag,props)=>({tag,props})},props};vm.createContext(ctx);vm.runInContext(code+';globalThis.node=ARRefresh(props)',ctx);return {node:ctx.node,updates,messages}}
(async()=>{
 let calls=0,release;const promise=new Promise(r=>release=r);let x=render({onClick:()=>{calls++;return promise}});
 assert.equal(x.node.props.style.height,30);assert.equal(x.node.props.style.fontSize,11.5);assert.equal(x.node.props.children[0].props.style.fontSize,13);assert.equal(x.node.props.children[1],'Refresh');
 const first=x.node.props.onClick({});await x.node.props.onClick({});assert.equal(calls,1);release();await first;assert.deepEqual(x.updates,[true,false]);
 x=render({busy:true,onClick:()=>calls++});assert(x.node.props.disabled);assert.equal(x.node.props.children[1],'Refreshing…');assert(x.node.props.children[0].props.className.includes('ph-circle-notch'));await x.node.props.onClick({});assert.equal(calls,1);
 x=render({onClick:async()=>{throw Error('fixture')}});await x.node.props.onClick({});assert.equal(x.messages.length,1);assert.deepEqual(x.updates,[true,false]);
 console.log('PASS: shared Sessions sizing, icons/labels, disabled state, duplicate-click guard, async completion and failure recovery');
})().catch(e=>{console.error(e);process.exitCode=1});
