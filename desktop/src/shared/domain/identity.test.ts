import { describe, expect, it } from "vitest";

import {
  documentKeyId,
  executionScopeId,
  isExecutionScope,
  isRuntimeId,
  makeDocumentKey,
  sameDocumentKey,
  sameExecutionScope,
  type ExecutionScope,
} from "./identity";

const scope: ExecutionScope = {
  connectionId: "server-generation-a",
  runtime: "prime",
  sessionId: "same-title-does-not-matter",
  root: "/work/project",
};

describe("scoped runtime identity", () => {
  it("keeps canonical runtimes and validates scope fields without rewriting them", () => {
    expect(["prime", "pi", "codex"].every(isRuntimeId)).toBe(true);
    expect(isRuntimeId("Prime")).toBe(false);
    expect(isExecutionScope(scope)).toBe(true);
    expect(isExecutionScope({ ...scope, runtime: "native" })).toBe(false);
    expect(isExecutionScope({ ...scope, root: "/work/\0project" })).toBe(false);
  });

  it("separates document buffers by connection, runtime, session, root, and exact path", () => {
    const key = makeDocumentKey(scope, "/work/project/src/app.ts");
    const samePathOnOtherServer = makeDocumentKey({ ...scope, connectionId: "server-generation-b" }, key.path);
    const samePathForPi = makeDocumentKey({ ...scope, runtime: "pi" }, key.path);
    const samePathForOtherSession = makeDocumentKey({ ...scope, sessionId: "other-session" }, key.path);
    const samePathForOtherRoot = makeDocumentKey({ ...scope, root: "/work/other" }, key.path);

    expect(sameExecutionScope(scope, { ...scope })).toBe(true);
    expect(sameExecutionScope(scope, samePathOnOtherServer.scope)).toBe(false);
    expect(sameDocumentKey(key, makeDocumentKey({ ...scope }, key.path))).toBe(true);
    expect([samePathOnOtherServer, samePathForPi, samePathForOtherSession, samePathForOtherRoot]
      .every((other) => documentKeyId(other) !== documentKeyId(key))).toBe(true);
    expect(executionScopeId(scope)).not.toBe(executionScopeId(samePathOnOtherServer.scope));
    expect(() => makeDocumentKey(scope, "")).toThrow(/path/i);
  });
});
