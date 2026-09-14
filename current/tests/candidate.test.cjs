const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { patchRenderer, verifyOfficial, prepareCollaboration } = require('../candidate.cjs');
const baseline = require('../baseline.json');

const rendererPath = path.join('/tmp', 'archon-v030-inspect-cyCnXr', 'dist/renderer/assets/index-DN77foUV.js');
const archivePath = process.env.ARCHON_V030_ASAR;
const renderer = archivePath ? require('@electron/asar').extractFile(archivePath, baseline.rendererPath).toString() : fs.existsSync(rendererPath) ? fs.readFileSync(rendererPath, 'utf8') : '';

test('candidate patch requires the official v0.3.0 archive', () => {
  assert.throws(() => verifyOfficial(Buffer.from('wrong archive')), /v0\.3\.0 archive/);
  assert.equal(baseline.version, '0.3.0');
});

test('candidate adds IDE, result links, and six workbench shortcuts', { skip: !renderer }, () => {
  const patched = patchRenderer(renderer);
  assert.match(patched, /id:"ide",icon:"ph-code",title:"IDE"/);
  for (const marker of ['function ArchonIde(', 'function ArchonWorkbench(', 'function ArchonResultLinks(', 'sessionId:E.id,cwd:E.cwd,messages:ke', 'ArchonCodeActions', '["1","2","3","4","5","6"]']) {
    assert.ok(patched.includes(marker), `Missing integration: ${marker}`);
  }
  assert.ok(patched.includes(fs.readFileSync(path.join(__dirname, '../ide-renderer.js'), 'utf8')), 'Helper injection preserves literal replacement characters');
  assert.ok(patched.includes('ASn(ArchonDeviceToken)'), 'Connection settings offer token setup');
  assert.ok(patched.includes('await K.host();if(!current())return;setTestResult'), 'Connection test verifies authorization for the current server');
  const check = require('node:child_process').spawnSync(process.execPath, ['--input-type=module', '--check'], { input: patched, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
});

test('candidate patch fails closed on missing or duplicated anchors', { skip: !renderer }, () => {
  assert.throws(() => patchRenderer(renderer.replace('const Qm=', 'const Other=')), /workbench tabs/);
  assert.throws(() => patchRenderer(`${renderer}${renderer.match(/const Qm=\[[^;]+\]/)[0]}`), /workbench tabs/);
  assert.throws(() => patchRenderer(patchRenderer(renderer)), /workbench tabs/);
});

test('bundled peer client uses local scripts and a narrowly allowed signaling socket',()=>{
 const root=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'archon-csp-test-'));
 try{
  const dir=path.join(root,'dist/renderer');fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'index.html'),"script-src 'self'; connect-src 'self' http: https:;");
  prepareCollaboration(root);
  assert.match(fs.readFileSync(path.join(dir,'index.html'),'utf8'),/script-src 'self'; connect-src 'self' http: https: wss:\/\/0.peerjs.com;/);
  assert.ok(fs.statSync(path.join(dir,'peerjs.min.js')).size>10000);
  assert.ok(fs.existsSync(path.join(dir,'peerjs.LICENSE')));
  assert.throws(()=>prepareCollaboration(root),/CSP anchor/);
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
