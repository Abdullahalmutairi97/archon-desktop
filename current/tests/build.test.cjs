const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { patchRenderer, verifyParent } = require('../build.cjs');
const replacements = require('../replacements.json');
const baseline = require('../baseline.json');
const helper = fs.readFileSync(path.join(__dirname, '../refresh.js'), 'utf8');
const fixture = replacements.map(([before]) => before).join('\n') + '\nfunction Ux(){}';

test('baseline metadata and kit agree on official 0.3.0', () => {
  assert.equal(require('../package.json').version, '0.3.0');
  assert.equal(require('../../package.json').version, baseline.version);
  assert.equal(require('../package-lock.json').packages[''].version, baseline.version);
  assert.equal(baseline.version, '0.3.0');
  assert.equal(baseline.authoritativeMachine, 'AbdullahPC');
  assert.equal(baseline.archiveSha256, '36d3ae03bd6b20c4e9ea5fc690461ef972b16eb0c9433bfb1305daeb068e549b');
});

test('six guarded replacements preserve all unrelated renderer text', () => {
  let result = patchRenderer(fixture, helper);
  for (const [before, after] of replacements) {
    assert.ok(result.includes(after));
    result = result.replace(after, before);
  }
  result = result.replace(helper + '\n', '');
  assert.equal(result, fixture);
});

test('wrong parent hash is rejected before archive extraction', () => {
  assert.throws(() => verifyParent(Buffer.from('wrong archive')), /parent archive/);
});

test('missing or duplicated patch targets fail closed', () => {
  assert.throws(() => patchRenderer('function Ux(){}', helper), /exactly once/);
  assert.throws(() => patchRenderer(fixture + replacements[0][0], helper), /exactly once/);
});

test('already patched renderer cannot be patched twice', () => {
  assert.throws(() => patchRenderer(patchRenderer(fixture, helper), helper), /already patched/);
});

test('missing or duplicated helper anchor fails closed', () => {
  assert.throws(() => patchRenderer(fixture.replace('function Ux()', 'function Other()'), helper), /anchor/);
  assert.throws(() => patchRenderer(fixture + 'function Ux(){}', helper), /anchor/);
});
