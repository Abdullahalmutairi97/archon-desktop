const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// The v0.3.0 main process maps a fixed list of operations to backend routes.
// Previews, Git and agent harnesses add their own; everything else still goes through the original bridge.
// Unlike the original fetchJson, errors keep the server's detail so Git's own message
// (a failing hook, a refused switch) reaches the user.
const extraOps = `var archonExtraOps = (() => {
  async function request(route, init = {}) {
    const method = init.method ?? "GET";
    const res = await fetch(\`\${api.baseUrl}\${route}\`, {
      method,
      headers: api.headers(init.json !== void 0),
      body: init.json !== void 0 ? JSON.stringify(init.json) : void 0,
      signal: AbortSignal.timeout(init.timeoutMs ?? 3e4),
    });
    if (res.status === 401) throw new Error("unauthorized: the device token was rejected");
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) {
      const detail = typeof body?.detail === "string" ? body.detail : "";
      throw new Error(\`\${method} \${route.split("?")[0]} \\u2192 \${res.status}\${detail ? ": " + detail : ""}\`);
    }
    return body;
  }
  const repo = p => String(p.path ?? ".");
  const files = p => Array.isArray(p.files) ? p.files.map(String) : [];
  const post = (route, json, timeoutMs) => request(route, { method: "POST", json, timeoutMs });
  return {
    previewOpen: p => post("/api/previews", { port: Number(p.port) }),
    previewClose: p => request(\`/api/previews/\${encodeURIComponent(String(p.id))}\`, { method: "DELETE" }),
    previews: () => request("/api/previews"),
    gitStatus: p => request(\`/api/git/status\${api.qs({ path: repo(p) })}\`),
    gitDiff: p => request(\`/api/git/diff\${api.qs({ path: repo(p), scope: p.scope, ref: p.ref, base: p.base, file: p.file })}\`, { timeoutMs: 6e4 }),
    gitLog: p => request(\`/api/git/log\${api.qs({ path: repo(p), ref: p.ref, limit: p.limit, skip: p.skip })}\`),
    gitBranches: p => request(\`/api/git/branches\${api.qs({ path: repo(p) })}\`),
    gitStage: p => post("/api/git/stage", { path: repo(p), files: files(p) }),
    gitUnstage: p => post("/api/git/unstage", { path: repo(p), files: files(p) }),
    gitDiscard: p => post("/api/git/discard", { path: repo(p), files: files(p), confirm: p.confirm === true }),
    gitCommit: p => post("/api/git/commit", { path: repo(p), message: String(p.message ?? "") }, 2e5),
    gitSwitch: p => post("/api/git/switch", { path: repo(p), branch: String(p.branch ?? ""), create: p.create === true }),
    gitFetch: p => post("/api/git/fetch", { path: repo(p) }, 13e4),
    gitPush: p => post("/api/git/push", { path: repo(p), confirm: p.confirm === true }, 2e5),
    harnesses: () => request("/api/harnesses"),
    harnessConfigure: p => request(\`/api/harnesses/\${encodeURIComponent(String(p.id))}\`, { method: "PUT", json: {
      ...(typeof p.enabled === "boolean" ? { enabled: p.enabled } : {}),
      ...(typeof p.default_model === "string" ? { default_model: p.default_model } : {}),
    } }),
    harnessCheck: p => post(\`/api/harnesses/\${encodeURIComponent(String(p.id))}/check\`, {}, 6e4),
    harnessUpdate: p => post(\`/api/harnesses/\${encodeURIComponent(String(p.id))}/update\`, { confirm: p.confirm === true }, 66e4),
  };
})();`;

function patchMain(source) {
  const once = (before, after, label) => {
    if (source.split(before).length !== 2) throw Error(`${label} target must occur exactly once`);
    source = source.replace(before, () => after);
  };
  once('var api = new ArchonApi();', `var api = new ArchonApi();\n${extraOps}`, 'Extra operations');
  once('import_electron3.ipcMain.handle("api:call", (_e, op, payload) => api.call(op, payload ?? {}));',
    'import_electron3.ipcMain.handle("api:call", (_e, op, payload) => Object.hasOwn(archonExtraOps, op) ? archonExtraOps[op](payload ?? {}) : api.call(op, payload ?? {}));',
    'Extra API routing');
  return source;
}

function prepareMain(app) {
  const mainFile = path.join(app, 'dist/main/main.cjs');
  const patched = patchMain(fs.readFileSync(mainFile, 'utf8'));
  const check = spawnSync(process.execPath, ['--check'], { input: patched, encoding: 'utf8' });
  if (check.error) throw check.error;
  if (check.status !== 0) throw Error(`main syntax validation failed: ${check.stderr}`);
  fs.writeFileSync(mainFile, patched);
}

module.exports = { patchMain, prepareMain };
