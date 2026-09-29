const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const {patchRenderer}=require('../candidate.cjs');
const baseline=require('../baseline.json');

const archive=process.env.ARCHON_V030_ASAR;
const renderer=archive?require('@electron/asar').extractFile(archive,baseline.rendererPath).toString():'';

// Run the shipped WebFrame alongside the actual collaboration handlers. The
// native view sits above DOM pixels, so a CSS z-index cannot fix this regression.
function mount(){
 const patched=patchRenderer(renderer),start=patched.indexOf('function Lm('),end=patched.indexOf('const Pe=',start);
 assert.ok(start>=0&&end>start,'Shipped WebFrame boundaries are available');
 const components=new Map(),surfaces=new Map();let active,cursor=0,dirty=false,tree;
 const ctx={ui:{view:'browser',bench:null},connected:true,settings:{serverUrl:'https://agent.test'},data:{projects:[],sessions:[]},say(){},setUi(patch){if(Object.keys(patch).some(key=>ctx.ui[key]!==patch[key]))dirty=true;Object.assign(ctx.ui,patch)}};
 const k={Fragment:Symbol('fragment'),useState(initial){const at=cursor++,slots=active.slots;if(!(at in slots))slots[at]=initial;return[slots[at],value=>{const next=typeof value==='function'?value(slots[at]):value;if(next!==slots[at])dirty=true;slots[at]=next}]},useRef(initial){const at=cursor++;return active.slots[at]||(active.slots[at]={current:initial})},useEffect(callback,deps){const at=cursor++,component=active,old=component.slots[at];if(!old||deps.some((value,i)=>value!==old.deps[i])){component.slots[at]={deps,cleanup:old?.cleanup};component.effects.push(()=>{component.slots[at].cleanup?.();component.slots[at].cleanup=callback()})}}};
 const element=(type,props,...children)=>{if(props?.ref)props.ref.current={getBoundingClientRect:()=>({left:0,top:0,width:600,height:400})};return{type,props:props||{},children:children.flat(Infinity)}};
 const window={archon:{web:{setBounds:(id,bounds,visible)=>surfaces.set(id,visible),hide:id=>surfaces.set(id,false)}},addEventListener(){},removeEventListener(){},setInterval:()=>1,clearInterval(){}};
 const scope=vm.createContext({k,r:{jsx:(type,props)=>element(type,props,props.children),jsxs:(type,props)=>element(type,props,props.children)},Ne:()=>ctx,ASn:element,window,ResizeObserver:class{observe(){}disconnect(){}},arUseTranscript:()=>({sessionId:'',messages:[]}),clearTimeout(){}});
 vm.runInContext(patched.slice(start,end)+'\n'+fs.readFileSync(require.resolve('../collab-renderer.js'),'utf8'),scope);
 for(const name of ['collab','browser','design'])components.set(name,{slots:[],effects:[]});
 const render=()=>{let rounds=0;do{dirty=false;for(const [name,component] of components){active=component;cursor=0;const next=name==='collab'?scope.ArchonCollab():scope.Lm({id:name});if(name==='collab')tree=next;while(component.effects.length)component.effects.shift()();}if(++rounds>20)throw Error('Render loop')}while(dirty)};
 function nodes(node=tree){return node&&typeof node==='object'?[node,...(node.children||[]).flatMap(nodes)]:[]}
 const click=label=>{const button=nodes().find(node=>node.type==='button'&&node.children.includes(label));assert.ok(button,'Button '+label+' is present');button.props.onClick();render()};
 render();return{ctx,surfaces,render,click,open(){ctx.setUi({bench:null,collabOpen:true});render()},escape(){nodes().find(node=>node.props.className==='ar-collab-backdrop').props.onKeyDown({key:'Escape'});render()},unmount(){const component=components.get('collab');components.delete('collab');component.slots.forEach(slot=>slot?.cleanup?.());render()}};
}

test('collaboration hides native browser and design surfaces and restores them on close, Escape or unmount',{skip:!renderer},()=>{
 const h=mount();const expectVisible=value=>{assert.equal(h.surfaces.get('browser'),value);assert.equal(h.surfaces.get('design'),value)};
 expectVisible(true);h.open();expectVisible(false);h.click('Close');expectVisible(true);
 h.open();expectVisible(false);h.escape();expectVisible(true);
 h.open();expectVisible(false);h.unmount();expectVisible(true);
});

test('closing collaboration does not uncover a native view while another dialog is open',{skip:!renderer},()=>{
 const h=mount();h.open();h.ctx.ui.dialog={title:'Another dialog'};h.render();h.click('Close');
 assert.equal(h.surfaces.get('browser'),false);assert.equal(h.surfaces.get('design'),false);
 h.ctx.ui.dialog=null;h.render();assert.equal(h.surfaces.get('browser'),true);assert.equal(h.surfaces.get('design'),true);
});
