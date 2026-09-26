import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { collectArtifacts, filePath, IdeWorkspace, normalizeIdeMessages, type IdeFilePort } from "./ide";
import { documentKeyId, makeDocumentKey, type ExecutionScope } from "./identity";

const require = createRequire(import.meta.url);
const legacy = require("../../../../current/ide-model.cjs") as {
  filePath: (value: unknown, cwd?: string) => string | null;
  collectArtifacts: (messages: unknown[], sessionId: string, cwd?: string) => unknown[];
};

const scope: ExecutionScope = {
  connectionId: "server-generation-a",
  runtime: "prime",
  sessionId: "session-a",
  root: "/workspace",
};

describe("IDE path and artifact projection", () => {
  it("preserves legacy path normalization and rejects malformed references", () => {
    for (const value of ["<src/app.ts:12>", "src%2Futil.ts", "Dockerfile", "/workspace/Makefile"]) {
      expect(filePath(value, "/workspace")).toBe(legacy.filePath(value, "/workspace"));
    }
    expect(filePath("../../outside.py", "/workspace/project")).toBe(legacy.filePath("../../outside.py", "/workspace/project"));
    expect(filePath("https://example.invalid/app.ts", "/workspace")).toBeNull();
    expect(filePath("src/%zz.ts", "/workspace")).toBeNull();
  });

  it("matches frozen artifact fixtures and normalizes server assistant roles and kind envelopes", () => {
    const oldMessages = [
      { id: "reply", role: "agent", content: 'See [code](src/app.ts:12) and `src/util.ts`. https://x.test/a.js' },
      { id: "tool", role: "agent", nativeKind: "tool", content: `write_file\n${JSON.stringify({ path: "src/new.ts", content: "const x=1;" })}` },
      { id: "thinking", role: "agent", nativeKind: "thinking", content: "```js\nprivate\n```" },
      { id: "patch", role: "agent", nativeKind: "tool", content: "apply_patch\n*** Begin Patch\n*** Update File: src/other.ts\n*** End Patch" },
      { id: "fence", role: "agent", content: '```python filename="app.py"\nprint(1)\n\n```' },
    ];
    expect(collectArtifacts(oldMessages, "one", "/project")).toEqual(legacy.collectArtifacts(oldMessages, "one", "/project"));

    const backendEnvelope = {
      messages: [
        { id: "assistant", role: "assistant", kind: "text", content: "See `src/server.ts`." },
        { id: "tool", role: "assistant", kind: "tool", content: `write_file\n${JSON.stringify({ path: "src/write.ts", content: "safe" })}` },
        { id: "thinking", role: "assistant", kind: "thinking", content: "```ts\nhidden\n```" },
        { id: "tool-result", role: "toolResult", kind: "tool_result", content: "do not collect" },
      ],
    };
    expect(normalizeIdeMessages(backendEnvelope).map((message) => [message.role, message.nativeKind])).toEqual([
      ["agent", undefined], ["agent", "tool"], ["agent", "thinking"],
    ]);
    const artifacts = collectArtifacts(backendEnvelope, "one", "/project");
    expect(artifacts.filter((item) => item.kind === "file").map((item) => item.path)).toEqual([
      "/project/src/server.ts", "/project/src/write.ts",
    ]);
    expect(artifacts.some((item) => item.kind === "snippet" && item.content === "hidden")).toBe(false);
  });
});

describe("scoped IDE workspace model", () => {
  it("keeps identical paths in different server/runtime/session scopes in separate documents", async () => {
    const reads: string[] = [];
    const writes: string[] = [];
    const port: IdeFilePort = {
      async read(currentScope, path) {
        reads.push(`${currentScope.connectionId}:${currentScope.runtime}:${currentScope.sessionId}:${path}`);
        return { content: currentScope.runtime === "codex" ? "local" : "remote", revision: currentScope.connectionId };
      },
      async write(currentScope, path, text) {
        writes.push(`${currentScope.connectionId}:${currentScope.runtime}:${currentScope.sessionId}:${path}:${text}`);
        return { ok: true, revision: "saved" };
      },
    };
    const workspace = new IdeWorkspace(port);
    const remoteKey = makeDocumentKey(scope, "/workspace/same.ts");
    const localScope: ExecutionScope = { ...scope, connectionId: "local-codex", runtime: "codex" };
    const localKey = makeDocumentKey(localScope, "/workspace/same.ts");

    await workspace.openFile(remoteKey);
    await workspace.openFile(localKey);
    const remoteId = documentKeyId(remoteKey);
    const localId = documentKeyId(localKey);
    workspace.edit(remoteId, "remote draft");
    workspace.edit(localId, "local draft");

    expect(remoteId).not.toBe(localId);
    expect(reads).toEqual([
      "server-generation-a:prime:session-a:/workspace/same.ts",
      "local-codex:codex:session-a:/workspace/same.ts",
    ]);
    expect(workspace.snapshot().docs[remoteId].text).toBe("remote draft");
    expect(workspace.snapshot().docs[localId].text).toBe("local draft");
    expect(workspace.hasDirtyDocuments(scope)).toBe(true);
    await workspace.save(remoteId);
    expect(writes).toEqual(["server-generation-a:prime:session-a:/workspace/same.ts:remote draft"]);
  });

  it("keeps dirty text after external changes and prevents stale reads from resurrecting closed tabs", async () => {
    let reads = 0;
    let releaseLateRead: ((value: { content: string }) => void) | undefined;
    const port: IdeFilePort = {
      async read(_currentScope, path) {
        if (path === "/workspace/late.ts") return new Promise((resolve) => { releaseLateRead = resolve; });
        reads += 1;
        return reads === 1
          ? { content: "original", revision: "v1" }
          : { content: "native edit", revision: "v2" };
      },
      async write() { return { ok: true }; },
    };
    const workspace = new IdeWorkspace(port);
    const key = makeDocumentKey(scope, "/workspace/file.ts");
    const id = documentKeyId(key);
    await workspace.openFile(key);
    workspace.edit(id, "unsaved draft");
    await workspace.save(id);
    expect(workspace.snapshot().docs[id].error).toMatch(/changed on disk/i);
    expect(workspace.snapshot().docs[id].text).toBe("unsaved draft");
    expect(workspace.close(id)).toBe(false);

    const lateKey = makeDocumentKey(scope, "/workspace/late.ts");
    const lateId = documentKeyId(lateKey);
    const opening = workspace.openFile(lateKey);
    expect(workspace.close(lateId, true)).toBe(true);
    releaseLateRead?.({ content: "late result" });
    await opening;
    expect(workspace.snapshot().docs[lateId]).toBeUndefined();
  });

  it("allows successive saves when successful writes omit revisions", async () => {
    let content = "original";
    let revision = "r1";
    const writes: string[] = [];
    const port: IdeFilePort = {
      async read() { return { content, revision }; },
      async write(_currentScope, _path, text, expectedBase) {
        writes.push(`${text}:${expectedBase}`);
        content = text;
        revision = revision === "r1" ? "r2" : "r3";
        return { ok: true };
      },
    };
    const workspace = new IdeWorkspace(port);
    const key = makeDocumentKey(scope, "/workspace/repeated-save.ts");
    const id = documentKeyId(key);

    await workspace.openFile(key);
    workspace.edit(id, "first save");
    await workspace.save(id);
    expect(workspace.snapshot().docs[id].error).toBe("");

    workspace.edit(id, "second save");
    await workspace.save(id);

    expect(writes).toEqual(["first save:r1", "second save:r2"]);
    expect(workspace.snapshot().docs[id]).toMatchObject({ text: "second save", base: "second save", error: "" });
  });

  it("keeps binary and truncated previews read-only", async () => {
    const port: IdeFilePort = {
      async read(_currentScope, path) {
        return path.endsWith("binary.dat")
          ? { content: "preview", binary: true }
          : { content: "partial", truncated: true };
      },
      async write() { return { ok: true }; },
    };
    const workspace = new IdeWorkspace(port);
    const binaryKey = makeDocumentKey(scope, "/workspace/binary.dat");
    const truncatedKey = makeDocumentKey(scope, "/workspace/partial.txt");
    await workspace.openFile(binaryKey);
    await workspace.openFile(truncatedKey);

    for (const key of [binaryKey, truncatedKey]) {
      const id = documentKeyId(key);
      workspace.edit(id, "overwrite");
      await workspace.save(id);
      expect(workspace.isDirty(id)).toBe(false);
      expect(workspace.snapshot().docs[id].readOnly).toBe(true);
    }
  });
});
