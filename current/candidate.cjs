// Build a reviewed v0.3.0 candidate without changing the frozen release recipe.
// The shipped v0.3.0 app is a packaged renderer; this candidate keeps the
// official archive as its input and applies guarded, reversible UI additions.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const baseline = require('./baseline.json');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function verifyOfficial(bytes) {
  if (sha256(bytes) !== baseline.archiveSha256) {
    throw new Error('Wrong v0.3.0 archive: expected the verified unified-refresh release');
  }
}

const tabsBefore = 'const Qm=[{id:"activity",icon:"ph-pulse",title:"Activity"},{id:"files",icon:"ph-folder-open",title:"Files"},{id:"browser",icon:"ph-globe",title:"Browser"},{id:"notes",icon:"ph-note",title:"Notes"},{id:"terminal",icon:"ph-terminal-window",title:"Terminal"}]';
const tabsAfter = 'const Qm=[{id:"activity",icon:"ph-pulse",title:"Activity"},{id:"files",icon:"ph-folder-open",title:"Files"},{id:"ide",icon:"ph-code",title:"IDE"},{id:"browser",icon:"ph-globe",title:"Browser"},{id:"notes",icon:"ph-note",title:"Notes"},{id:"terminal",icon:"ph-terminal-window",title:"Terminal"}]';
const titleTabsBefore = 'const uy=[{id:"activity",icon:"ph-pulse",title:"Activity",live:!0},{id:"files",icon:"ph-folder-open",title:"Files"},{id:"browser",icon:"ph-globe",title:"Browser"},{id:"notes",icon:"ph-note",title:"Notes"},{id:"terminal",icon:"ph-terminal-window",title:"Terminal"}]';
const titleTabsAfter = 'const uy=[{id:"activity",icon:"ph-pulse",title:"Activity",live:!0},{id:"files",icon:"ph-folder-open",title:"Files"},{id:"ide",icon:"ph-code",title:"IDE"},{id:"browser",icon:"ph-globe",title:"Browser"},{id:"notes",icon:"ph-note",title:"Notes"},{id:"terminal",icon:"ph-terminal-window",title:"Terminal"}]';
const benchBefore = "ui.bench==='files'&&ASn(pf,{compact:true}),ui.bench==='browser'&&ASn(uf,{compact:true})";
const benchAfter = "ui.bench==='files'&&ASn(pf,{compact:true}),ui.bench==='ide'&&ASn(ArchonIde),ui.bench==='browser'&&ASn(uf,{compact:true})";
const shortcutBefore = 'x&&["1","2","3","4","5"].includes(y)';
const shortcutAfter = 'x&&["1","2","3","4","5","6"].includes(y)';
const shortcutTabsBefore = '["activity","files","browser","notes","terminal"]';
const shortcutTabsAfter = '["activity","files","ide","browser","notes","terminal"]';

// This is deliberately a small composition over the existing v0.3.0 Files and
// Terminal views. It keeps their server-side permissions, save guards and tmux
// lifecycle intact while giving them one IDE entry point.
const ideHelper = String.raw`function ArchonIde(){const [tab,setTab]=k.useState('files');const button=(id,icon,label)=>ASn('button',{type:'button',className:'reset-btn',role:'tab','aria-selected':tab===id,onClick:()=>setTab(id),style:{display:'flex',alignItems:'center',gap:6,padding:'5px 9px',borderRadius:'var(--radius-md)',fontSize:11.5,cursor:'pointer',color:tab===id?'var(--color-accent)':'inherit',opacity:tab===id?1:.6,background:tab===id?'var(--ar-hover)':'transparent'}},ASicon(icon),ASn('span',null,label));return ASn('div',{style:{flex:1,minHeight:0,display:'flex',flexDirection:'column'}},ASn('div',{style:{flex:'none',display:'flex',alignItems:'center',gap:2,padding:'7px 9px',borderBottom:'1px solid var(--ar-edge)'}},button('files','ph-folder-open','Editor'),button('terminal','ph-terminal-window','Terminal'),ASn('span',{style:{marginInlineStart:'auto',fontSize:10,opacity:.4}},'IDE')),tab==='files'&&ASn(pf,{compact:true}),tab==='terminal'&&ASn(ey));}`;

// The browser starts with the configured shortcuts. This small result strip
// adds links found in the agent's visible transcript, so a finished task can
// open its cited work in the same side panel without copying URLs by hand.
const linksHelper = String.raw`function ArchonResultLinks({onOpen}){const {data}=Ne();const links=[];for(const message of data.thread??[]){if(message.role!=='agent')continue;const found=String(message.content??'').match(/https?:\/\/[^\s<>"')\]]+/g)||[];for(const raw of found){const url=raw.replace(/[.,;:!?]+$/,'');if(url&&!links.includes(url))links.push(url)}}const recent=links.slice(-6);if(!recent.length)return null;return r.jsxs('div',{style:{flex:'none',display:'flex',flexDirection:'column',gap:6,padding:'8px 10px 10px',borderTop:'1px solid var(--ar-edge)',background:'var(--ar-panel)'},children:[r.jsxs('div',{style:{display:'flex',alignItems:'center',gap:6,fontSize:10,letterSpacing:'.08em',textTransform:'uppercase',opacity:.48},children:[r.jsx('i',{className:'ph ph-link-simple',style:{fontSize:12}}),r.jsx('span',{children:'From agent result'})]}),r.jsx('div',{style:{display:'flex',gap:6,flexWrap:'wrap'},children:recent.map(url=>r.jsxs('button',{type:'button',onClick:()=>onOpen(url),className:'reset-btn hov-tint',title:url,style:{display:'flex',alignItems:'center',gap:5,maxWidth:'100%',padding:'4px 8px',border:'1px solid var(--ar-edge)',borderRadius:999,fontSize:10.5,cursor:'pointer'},children:[r.jsx('i',{className:'ph ph-arrow-up-right',style:{fontSize:11}}),r.jsx('span',{style:{maxWidth:220,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'},children:url.replace(/^https?:\/\//,'')})]},url))})]})}`;

function patchRenderer(original) {
  let result = original;
  const replaceOnce = (before, after, label) => {
    if (result.split(before).length !== 2) throw new Error(`${label} target must occur exactly once`);
    result = result.replace(before, after);
  };

  replaceOnce(tabsBefore, tabsAfter, 'workbench tabs');
  replaceOnce(titleTabsBefore, titleTabsAfter, 'titlebar tabs');
  replaceOnce(shortcutBefore, shortcutAfter, 'shortcut count');
  replaceOnce(shortcutTabsBefore, shortcutTabsAfter, 'shortcut tab order');
  replaceOnce(benchBefore, benchAfter, 'IDE render branch');

  // Keep the helper in the renderer's module scope. Function declarations are
  // hoisted, so it can use the existing React and component aliases.
  replaceOnce('function ty(){', `${linksHelper}\n${ideHelper}\nfunction ty(){`, 'workbench helper anchor');

  // Render transcript links below the browser's empty-state shortcuts. The
  // exact anchor is stable in the verified v0.3.0 bundle and is guarded here.
  const resultStripAnchor = 'E&&!A&&r.jsx("div",{style:{flex:"none",display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",padding:n?"0 10px 12px":"0 14px 14px"},children:Wm(s.serverUrl).map(P=>r.jsxs("button"';
  if (result.split(resultStripAnchor).length !== 2) throw new Error('browser result-link anchor must occur exactly once');
  result = result.replace(resultStripAnchor, `${resultStripAnchor}`);
  // Insert the component after the existing shortcut strip without changing
  // that strip's behavior. The closing `})]})}` is unique in this block.
  const shortcutStrip = '})]})}const Bm=typeof navigator';
  if (result.split(shortcutStrip).length !== 2) throw new Error('browser shortcut strip terminator must occur exactly once');
  result = result.replace(shortcutStrip, '}),r.jsx(ArchonResultLinks,{onOpen:w})]})}const Bm=typeof navigator');

  return result;
}

async function build(args) {
  if (args.length !== 2) throw new Error('Usage: npm run build:candidate -- /path/to/v0.3.0.asar /new/candidate.asar');
  const [input, output] = args.map(value => path.resolve(value));
  if (fs.existsSync(output)) throw new Error('Output already exists; choose a new candidate path');
  verifyOfficial(fs.readFileSync(input));
  const asar = require('@electron/asar');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'archon-v030-candidate-'));
  try {
    const app = path.join(temp, 'app');
    asar.extractAll(input, app);
    const renderer = path.join(app, baseline.rendererPath);
    const patched = patchRenderer(fs.readFileSync(renderer, 'utf8'));
    const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: patched, encoding: 'utf8' });
    if (syntax.error) throw syntax.error;
    if (syntax.status !== 0) throw new Error(`Candidate renderer failed JavaScript syntax validation: ${syntax.stderr}`);
    fs.writeFileSync(renderer, patched);
    const pkg = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
    if (pkg.version !== baseline.version) throw new Error(`Candidate package must remain v${baseline.version}`);
    await asar.createPackage(app, output);
    console.log(`Built v${pkg.version} candidate: ${output}\nsha256 ${sha256(fs.readFileSync(output))}`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

module.exports = { patchRenderer, verifyOfficial };
if (require.main === module) build(process.argv.slice(2)).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
