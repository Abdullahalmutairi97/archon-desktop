// Reconstruct the verified final patch without touching an installed application.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const baseline = require('./baseline.json');
const replacements = require('./replacements.json');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function verifyParent(bytes) {
  if (sha256(bytes) !== baseline.parentArchiveSha256) {
    throw new Error('Wrong parent archive: expected the frozen v0.3.0 agent-resources build');
  }
}

function patchRenderer(original, helper) {
  if (original.includes('function ARRefresh(')) throw new Error('Renderer already patched');
  if (original.split('function Ux(').length !== 2) throw new Error('Expected one helper anchor');
  let result = original;
  for (const [before, after] of replacements) {
    if (result.split(before).length !== 2) throw new Error('Patch target must occur exactly once');
    result = result.replace(before, after);
  }
  result = result.replace('function Ux(', helper + '\nfunction Ux(');
  let restored = result.replace(helper + '\n', '');
  for (const [before, after] of replacements) restored = restored.replace(after, before);
  if (restored !== original) throw new Error('Patch changed unrelated renderer content');
  return result;
}

async function main(args) {
  if (args.length !== 2) throw new Error('Usage: npm run build -- /path/to/parent.asar /new/output.asar');
  const [parent, output] = args.map(value => path.resolve(value));
  // Never overwrite the source archive, an installed app, or any prior output.
  if (fs.existsSync(output)) throw new Error('Output already exists; choose a new artifact path');
  verifyParent(fs.readFileSync(parent));
  const asar = require('@electron/asar');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'archon-v030-build-'));
  try {
    const app = path.join(temp, 'app');
    asar.extractAll(parent, app);
    const renderer = path.join(app, baseline.rendererPath);
    const patched = patchRenderer(fs.readFileSync(renderer, 'utf8'), fs.readFileSync(path.join(__dirname, 'refresh.js'), 'utf8'));
    const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: patched, encoding: 'utf8' });
    if (syntax.error) throw syntax.error;
    if (syntax.status !== 0) throw new Error('Reconstructed renderer failed JavaScript syntax validation');
    fs.writeFileSync(renderer, patched);
    for (const [name, expected] of Object.entries(baseline.files)) {
      if (sha256(fs.readFileSync(path.join(app, name))) !== expected) throw new Error(`Baseline file mismatch: ${name}`);
    }
    if (JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8')).version !== baseline.version) {
      throw new Error('Package version does not match official baseline');
    }
    const artifact = path.join(temp, 'app.asar');
    await asar.createPackage(app, artifact);
    if (sha256(fs.readFileSync(artifact)) !== baseline.archiveSha256) {
      throw new Error('Repacked archive is not byte-identical to AbdullahPC; no output published');
    }
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(artifact, output, fs.constants.COPYFILE_EXCL);
    console.log(`Verified v${baseline.version}: ${baseline.archiveSha256}\n${output}`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

module.exports = { patchRenderer, verifyParent };
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
