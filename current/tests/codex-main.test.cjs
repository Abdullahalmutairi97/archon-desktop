const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { patchMain } = require('../codex-main-patch.cjs');

const fixture = `var win = window;
var api = new ArchonApi();
import_electron3.ipcMain.handle("api:call", (_e, op, payload) => api.call(op, payload ?? {}));`;

test('Codex native routing preserves remote calls and asks before granting approvals', async () => {
  let options, handler, quit, consent = 0;
  const requests = [], emitted = [];
  const context = {
    window: { isDestroyed: () => false, webContents: { send: (...args) => emitted.push(args) } },
    ArchonApi: class { call(...args) { requests.push(args); return 'remote response'; } },
    require: () => ({ createCodexAdapter: config => {
      options = config;
      return { call: (op, payload, remote) => remote(op, payload), close: () => requests.push(['closed']) };
    } }),
    import_node_path5: require('node:path'),
    import_electron3: {
      app: { getPath: () => '/test-profile', on: (event, callback) => { assert.equal(event, 'before-quit'); quit = callback; } },
      ipcMain: { handle: (event, callback) => { assert.equal(event, 'api:call'); handler = callback; } },
      dialog: { showMessageBox: async (_, config) => { assert.equal(config.defaultId, 0); assert.equal(config.cancelId, 0); return { response: consent }; } },
    },
  };
  vm.runInNewContext(patchMain(fixture), context);
  assert.equal(options.userDataDir, '/test-profile/codex-agent');
  assert.equal(await handler({}, 'sessions', { limit: 10 }), 'remote response');
  assert.deepEqual(requests, [['sessions', { limit: 10 }]]);
  assert.equal(await options.approve({ kind: 'command', command: 'example' }), false);
  consent = 1;
  assert.equal(await options.approve({ kind: 'command', command: 'example' }), true);
  context.window.isDestroyed = () => true;
  assert.equal(await options.approve({ kind: 'command' }), false);
  options.emit({ type: 'task.completed' });
  assert.deepEqual(emitted, [['archon:event', { type: 'task.completed' }]]);
  quit();
  assert.deepEqual(requests.at(-1), ['closed']);
});

test('Codex native injection rejects missing, duplicate, and already patched anchors', () => {
  assert.throws(() => patchMain(''), /exactly once/);
  assert.throws(() => patchMain(fixture + fixture), /exactly once/);
  assert.throws(() => patchMain(patchMain(fixture)), /exactly once/);
});
