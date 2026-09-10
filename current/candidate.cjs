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
const shortcutBefore = 'x&&["1","2","3","4","5"].includes(y)';
const shortcutAfter = 'x&&["1","2","3","4","5","6"].includes(y)';
const shortcutTabsBefore = '["activity","files","browser","notes","terminal"]';
const shortcutTabsAfter = '["activity","files","ide","browser","notes","terminal"]';

const ideHelpers = fs.readFileSync(path.join(__dirname, 'ide-model.cjs'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, 'ide-renderer.js'), 'utf8');

function patchRenderer(original) {
  let result = original;
  const replaceOnce = (before, after, label) => {
    if (result.split(before).length !== 2) throw new Error(`${label} target must occur exactly once`);
    result = result.replace(before, () => after);
  };

  replaceOnce(tabsBefore, tabsAfter, 'workbench tabs');
  replaceOnce(titleTabsBefore, titleTabsAfter, 'titlebar tabs');
  replaceOnce(shortcutBefore, shortcutAfter, 'shortcut count');
  replaceOnce(shortcutTabsBefore, shortcutTabsAfter, 'shortcut tab order');
  if (result.split(benchBefore).length !== 2) throw new Error('IDE render branch must occur exactly once');
  const start = result.indexOf('function ty(){');
  const end = result.indexOf('const Zl=', start);
  if (start < 0 || end < 0) throw new Error('Workbench component boundary missing');
  result = result.slice(0,start) + 'function ty(){return ASn(ArchonWorkbench)}\n' + result.slice(end);

  // Keep the helper in the renderer's module scope. Function declarations are
  // hoisted, so it can use the existing React and component aliases.
  replaceOnce('function ty(){', `${ideHelpers}\nfunction ty(){`, 'workbench helper anchor');

  replaceOnce('children:[ke.map((T,ie)=>{', 'children:[r.jsx(ArchonTranscript,{sessionId:E.id,cwd:E.cwd,messages:ke}),ke.map((T,ie)=>{', 'active transcript');
  replaceOnce('r.jsx(jf,{text:n.content}),n.streaming', 'r.jsx(ArchonMarkdown,{text:n.content}),r.jsx(ArchonCodeActions,{message:n}),n.streaming', 'reply code action');

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
