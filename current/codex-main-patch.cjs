const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function patchMain(source) {
  const once = (before, after, label) => {
    if (source.split(before).length !== 2) throw Error(`${label} target must occur exactly once`);
    source = source.replace(before, () => after);
  };
  once('var api = new ArchonApi();', `var api = new ArchonApi();
var codexAdapter = require('./codex-adapter.cjs').createCodexAdapter({
  userDataDir: (0, import_node_path5.join)(import_electron3.app.getPath('userData'), 'codex-agent'),
  emit: event => win?.webContents.send('archon:event', event),
  approve: async request => {
    if (!win || win.isDestroyed()) return false;
    const detail = [request.reason, request.command, request.cwd, ...(request.paths || [])]
      .filter(value => typeof value === 'string' && value).join('\\n\\n').slice(0, 12000);
    const answer = await import_electron3.dialog.showMessageBox(win, {
      type: 'question', title: 'Codex permission',
      message: request.kind === 'file' ? 'Allow Codex to change these files?' : 'Allow this Codex command?',
      detail, buttons: ['Cancel', 'Allow once'], defaultId: 0, cancelId: 0, noLink: true,
    });
    return answer.response === 1;
  },
});
import_electron3.app.on('before-quit', () => { void codexAdapter.close(); });`, 'Codex native adapter');
  once('import_electron3.ipcMain.handle("api:call", (_e, op, payload) => api.call(op, payload ?? {}));',
    'import_electron3.ipcMain.handle("api:call", (_e, op, payload) => codexAdapter.call(op, payload ?? {}, (remoteOp, remotePayload) => api.call(remoteOp, remotePayload)));', 'Codex API routing');
  return source;
}

function prepareCodex(app) {
  const mainFile = path.join(app, 'dist/main/main.cjs');
  const patched = patchMain(fs.readFileSync(mainFile, 'utf8'));
  const nativeFile = path.join(__dirname, 'codex-adapter.cjs');
  for (const [label, source] of [['main', patched], ['Codex adapter', fs.readFileSync(nativeFile, 'utf8')]]) {
    const check = spawnSync(process.execPath, ['--check'], { input: source, encoding: 'utf8' });
    if (check.error) throw check.error;
    if (check.status !== 0) throw Error(`${label} syntax validation failed: ${check.stderr}`);
  }
  fs.writeFileSync(mainFile, patched);
  fs.copyFileSync(nativeFile, path.join(app, 'dist/main/codex-adapter.cjs'));
}

module.exports = { patchMain, prepareCodex };
