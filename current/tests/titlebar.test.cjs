const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {patchTitlebar}=require('../titlebar-patch.cjs');
const {patchRenderer}=require('../candidate.cjs');
const baseline=require('../baseline.json');

const scope=vm.createContext({k:{Fragment:'fragment'},ASn:(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity)}),ASicon:name=>({type:'icon',props:{name},children:[]})});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../runtime-renderer.js'),'utf8')+fs.readFileSync(path.join(__dirname,'../titlebar-renderer.js'),'utf8')+'\nthis.Title=ArchonTitle;',scope);
const nodes=t=>!t||typeof t!=='object'?[]:[t,...(t.children||[]).flatMap(nodes)];
const text=t=>nodes(t).filter(n=>n.type!=='style').flatMap(n=>n.children.filter(c=>typeof c==='string')).join(' ');

test('the title names the session, its project and its agent without a model pill',()=>{
 const tree=scope.Title({session:{title:'Fix login',runtime:'opencode'},project:{name:'Web'},label:'Fix login'});
 assert.equal(text(tree),'Web / Fix login');
 const agent=nodes(tree).find(n=>n.props.className==='ar-title-agent');
 assert.equal(agent.props.title,'OpenCode session');assert.equal(nodes(agent).find(n=>n.type==='icon').props.name,'ph-code');
 const page=scope.Title({session:null,project:null,label:'Sessions'});
 assert.ok(!nodes(page).some(n=>n.props.className==='ar-title-agent'));
 assert.ok(nodes(page).some(n=>n.props.className==='ar-title-text'&&n.children.includes('Sessions')));
});

const archive=process.env.ARCHON_V030_ASAR;
test('the shipped title bar loses the agent pill and gains a Share icon',{skip:!archive},()=>{
 const out=patchRenderer(require('@electron/asar').extractFile(archive,baseline.rendererPath).toString());
 assert.ok(!out.includes('Select the MiniPC agent and model for new sessions'));
 assert.ok(out.includes('r.jsx(ArchonTitle,{session:p,project:p?h:null'));
 assert.ok(out.includes('onClick:()=>l({bench:null,collabOpen:!0})')&&out.includes('ph ph-share-network'));
 assert.ok(!out.includes('ar-collab-launch'),'the floating Share button is gone');
 assert.throws(()=>patchTitlebar(out),/Title bar/);
});
