const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../connection-renderer.js'), 'utf8');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

// Exercise the actual component's handlers and effect cleanup without Electron,
// a real token, network requests, or a second copy of its state transitions.
function renderToken(bridge, refresh = async () => {}) {
  const hooks = [];
  let cursor = 0, dirty = true, mounted = true, tree, lateUpdates = 0;
  let effects = [];
  const context = { settings: { serverUrl: 'https://one.example' }, refresh };
  const k = {
    useState(initial) {
      const index = cursor++;
      if (!hooks[index]) hooks[index] = { value: initial };
      return [hooks[index].value, value => {
        if (!mounted) lateUpdates++;
        hooks[index].value = typeof value === 'function' ? value(hooks[index].value) : value;
        dirty = true;
      }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!hooks[index]) hooks[index] = { current: initial };
      return hooks[index];
    },
    useEffect(effect, deps) {
      const index = cursor++;
      const previous = hooks[index];
      if (!previous || !deps || deps.some((value, i) => value !== previous.deps[i])) {
        hooks[index] = { deps, cleanup: previous?.cleanup };
        effects.push(() => {
          hooks[index].cleanup?.();
          hooks[index].cleanup = effect();
        });
      }
    }
  };
  const sandbox = {
    k, Ne: () => context,
    window: bridge === undefined ? {} : { archon: { token: bridge } },
    ASsection: 'section',
    ASn: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) })
  };
  vm.runInNewContext(`${source}\nthis.Component = ArchonDeviceToken;`, sandbox);
  function render() {
    while (dirty && mounted) {
      dirty = false;
      cursor = 0;
      tree = sandbox.Component();
      const pendingEffects = effects;
      effects = [];
      for (const effect of pendingEffects) effect();
    }
    return tree;
  }
  const text = node => typeof node === 'string' ? node : (node?.children || []).map(text).join('');
  function find(predicate, node = render()) {
    if (!node || typeof node !== 'object') return undefined;
    if (predicate(node)) return node;
    for (const child of node.children) { const result = find(predicate, child); if (result) return result; }
  }
  const input = () => find(node => node.type === 'input');
  const button = () => find(node => node.type === 'button');
  return {
    render, input, button,
    status: () => text(find(node => node.props.role === 'status')),
    enter(value) { input().props.onChange({ target: { value } }); render(); },
    save() { return button().props.onClick(); },
    switchServer() { context.settings = { serverUrl: 'https://two.example' }; dirty = true; render(); },
    async flush() { for (let i = 0; i < 12; i++) { await Promise.resolve(); render(); } },
    unmount() { mounted = false; for (const hook of hooks) hook?.cleanup?.(); },
    get lateUpdates() { return lateUpdates; }
  };
}

test('token settings finish checking when the desktop bridge or present method is unavailable', async () => {
  for (const bridge of [undefined, {}]) {
    const ui = renderToken(bridge);
    assert.doesNotThrow(() => ui.render());
    await ui.flush();
    assert.doesNotMatch(ui.status(), /Checking credentials/);
    assert.match(ui.status(), /credentials|desktop/i);
  }
});

test('a delayed credential presence result cannot undo a successful token save', async () => {
  const presence = deferred();
  const ui = renderToken({ present: () => presence.promise, write: async () => 'safeStorage' });
  ui.render();
  ui.enter('test-only-token');
  await ui.save();
  presence.resolve(false);
  await ui.flush();
  assert.match(ui.status(), /Device token saved/);
  assert.equal(ui.input().props.placeholder, 'A token is already stored');
});

test('refresh errors are distinguished from failure to save a token', async () => {
  let writes = 0;
  const ui = renderToken({ present: async () => false, write: async () => { writes++; return 'file-0600'; } }, async () => { throw Error('offline'); });
  await ui.flush();
  ui.enter(' test-only-token ');
  await ui.save();
  await ui.flush();
  assert.equal(writes, 1);
  assert.match(ui.status(), /Device token saved/);
  assert.doesNotMatch(ui.status(), /Could not save/);
  assert.equal(ui.input().props.value, '');
  assert.equal(ui.input().props.disabled, false);
});

test('switching server during a save suppresses its old refresh and reconciles credential presence', async () => {
  const writing = deferred();
  let refreshes = 0, stored = false;
  const ui = renderToken({ present: async () => stored, write: () => writing.promise }, async () => { refreshes++; });
  await ui.flush();
  ui.enter('test-only-token');
  const saving = ui.save();
  ui.switchServer();
  await ui.flush();
  stored = true;
  writing.resolve('safeStorage');
  await saving;
  await ui.flush();
  assert.equal(refreshes, 0);
  assert.equal(ui.status(), 'Device token stored');
  assert.equal(ui.input().props.placeholder, 'A token is already stored');
  assert.equal(ui.input().props.disabled, false);
});

test('unmounting token settings invalidates pending save callbacks', async () => {
  const writing = deferred();
  let refreshes = 0;
  const ui = renderToken({ present: async () => false, write: () => writing.promise }, async () => { refreshes++; });
  await ui.flush();
  ui.enter('test-only-token');
  const saving = ui.save();
  ui.unmount();
  writing.resolve('safeStorage');
  await saving;
  assert.equal(refreshes, 0);
  assert.equal(ui.lateUpdates, 0);
});

test('a repeated save event cannot race two global credential writes', async () => {
  const writing = deferred();
  let writes = 0;
  const ui = renderToken({ present: async () => false, write: () => { writes++; return writing.promise; } });
  await ui.flush();
  ui.enter('test-only-token');
  const click = ui.button().props.onClick;
  const first = click(), second = click();
  await ui.flush();
  writing.resolve('safeStorage');
  await Promise.all([first, second]);
  assert.equal(writes, 1);
});

test('write errors preserve the draft and unlock token entry for retry', async () => {
  for (const write of [undefined, async () => { throw Error('disk unavailable'); }]) {
    const ui = renderToken({ present: async () => false, write });
    await ui.flush();
    ui.enter('test-only-token');
    await ui.save();
    await ui.flush();
    assert.match(ui.status(), /Could not save/);
    assert.equal(ui.input().props.value, 'test-only-token');
    assert.equal(ui.input().props.disabled, false);
  }
});
