const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { patchRenderer, verifyOfficial } = require('../candidate.cjs');
const baseline = require('../baseline.json');

const rendererPath = path.join('/tmp', 'archon-v030-inspect-cyCnXr', 'dist/renderer/assets/index-DN77foUV.js');
const renderer = fs.existsSync(rendererPath) ? fs.readFileSync(rendererPath, 'utf8') : '';

test('candidate patch requires the official v0.3.0 archive', () => {
  assert.throws(() => verifyOfficial(Buffer.from('wrong archive')), /v0\.3\.0 archive/);
  assert.equal(baseline.version, '0.3.0');
});

test('candidate adds IDE, result links, and six workbench shortcuts', { skip: !renderer }, () => {
  const patched = patchRenderer(renderer);
  assert.match(patched, /id:"ide",icon:"ph-code",title:"IDE"/);
  assert.match(patched, /function ArchonIde\(\)/);
  assert.match(patched, /function ArchonResultLinks\(\{onOpen\}\)/);
  assert.match(patched, /\["1","2","3","4","5","6"\]/);
  assert.match(patched, /ui\.bench==='ide'&&ASn\(ArchonIde\)/);
  const check = require('node:child_process').spawnSync(process.execPath, ['--input-type=module', '--check'], { input: patched, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
});

test('candidate patch fails closed on missing or duplicated anchors', { skip: !renderer }, () => {
  assert.throws(() => patchRenderer(renderer.replace('const Qm=', 'const Other=')), /workbench tabs/);
  assert.throws(() => patchRenderer(`${renderer}${renderer.match(/const Qm=\[[^;]+\]/)[0]}`), /workbench tabs/);
  assert.throws(() => patchRenderer(patchRenderer(renderer)), /workbench tabs/);
});
