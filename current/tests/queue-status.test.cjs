const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { ArchonQueueData, patchRendererQueueStatus } = require('../queue-status-patch.cjs');
const archive = process.env.ARCHON_V030_ASAR;
const fallback = '/tmp/archon-audit-source/dist/renderer/assets/index-DN77foUV.js';
const renderer = archive ? require('@electron/asar').extractFile(archive, require('../baseline.json').rendererPath).toString() : fs.existsSync(fallback) ? fs.readFileSync(fallback, 'utf8') : '';

function liveData(status = 'queued') {
  // Use the real release's API converters: its session active flag also covers
  // accepted work which has never been claimed by a worker.
  const context = vm.createContext({ R: (v, d = '') => typeof v === 'string' ? v : d, Ct: v => Number(v) || 0, rp: v => v || '', Yg: { queued: 'queued', running: 'working', completed: 'finished', failed: 'failed' } });
  for (const [start, end] of [['function Xg(', 'function sp('], ['function bl(', 'function Xp(']]) {
    vm.runInContext(renderer.slice(renderer.indexOf(start), renderer.indexOf(end, renderer.indexOf(start))), context);
  }
  const session = context.Xg({ id: 'prime-audit', title: 'Text tools audit', active: true, message_count: 0, project_id: 'audit-project' });
  const task = context.bl({ id: 'audit-task', session_id: session.id, status, started_at: status === 'queued' ? null : '2026-09-12T05:47:41Z' });
  return { sessions: [session], tasks: [task], projects: [{ id: 'audit-project', running: 1 }], host: { running: 1 } };
}

test('real queued tasks do not appear as working sessions or running projects', { skip: !renderer }, () => {
  const data = liveData(), shown = ArchonQueueData(data);
  assert.equal(shown.sessions[0].state, 'queued');
  assert.equal(shown.projects[0].running, 0);
  assert.equal(shown.projects[0].queued, 1);
  assert.equal(shown.host.running, 0);
  assert.equal(shown.host.queued, 1);
  assert.equal(data.sessions[0].state, 'working', 'display normalization must not mutate store data');
});

test('session badges follow actual task start, finish, and failure events', { skip: !renderer }, () => {
  for (const [status, state, running] of [['running', 'working', 1], ['completed', 'done', 0], ['failed', 'error', 0]]) {
    const shown = ArchonQueueData(liveData(status));
    assert.equal(shown.sessions[0].state, state);
    assert.equal(shown.projects[0].running, running);
    assert.equal(shown.projects[0].queued, 0);
  }
});

test('a running turn takes precedence over a later queued prompt', { skip: !renderer }, () => {
  const data = liveData('running');
  data.tasks.unshift({ id: 'follow-up', sessionId: 'prime-audit', state: 'queued' });
  const shown = ArchonQueueData(data);
  assert.equal(shown.sessions[0].state, 'working');
  assert.equal(shown.projects[0].running, 1);
  assert.equal(shown.projects[0].queued, 1);
});

test('native history without a matching task retains its own activity state', () => {
  const data = { sessions: [{ id: 'native', state: 'working', readOnly: true }], tasks: [], projects: [], host: {} };
  assert.equal(ArchonQueueData(data).sessions[0].state, 'working');
});

test('actual session header renders Queued instead of Working before execution', { skip: !renderer }, () => {
  const patched = patchRendererQueueStatus(renderer);
  const start = patched.indexOf('Y&&r.jsxs("span",{title:Y.state');
  const end = patched.indexOf(',ae.length>0&&', start);
  const expression = patched.slice(start, end);
  const r = { jsx: (type, props) => ({ type, ...props }), jsxs: (type, props) => ({ type, ...props }) };
  for (const [state, label] of [['queued', 'Queued'], ['working', 'Working'], ['cancelling', 'Cancelling']]) {
    const header = vm.runInNewContext(expression, { Y: { state }, r });
    assert.equal(header.children[1], label);
    if (state === 'queued') assert.match(header.title, /waiting/i);
  }
});

test('patch normalizes context data and refuses missing or duplicate anchors', { skip: !renderer }, () => {
  const patched = patchRendererQueueStatus(renderer);
  assert.ok(patched.includes('data:arQueueData'));
  assert.ok(patched.includes('visibleSessions:Ke'));
  assert.throws(() => patchRendererQueueStatus(renderer.replace('function Ne(){', 'function MissingNe(){')), /queue/);
  assert.throws(() => patchRendererQueueStatus(renderer + 'function Ne(){'), /queue/);
  assert.throws(() => patchRendererQueueStatus(patched), /queue/);
});
