/**
 * Runtime and document identity used by the authored source build.
 *
 * Origin: the fixed P2 shared-interface contract, with the runtime-selection
 * boundaries described by `current/codex-renderer.js`. This module is newly
 * authored; it does not copy local/server identity by display name or title.
 */

export type RuntimeId = "prime" | "pi" | "codex";

export interface ExecutionScope {
  /** Opaque server connection generation, or a stable local namespace. */
  connectionId: string;
  runtime: RuntimeId;
  sessionId: string;
  /** Canonical session/project root selected by the owning runtime. */
  root: string;
}

export interface DocumentKey {
  scope: ExecutionScope;
  path: string;
}

function isNonEmptyIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

export function isRuntimeId(value: unknown): value is RuntimeId {
  return value === "prime" || value === "pi" || value === "codex";
}

export function isExecutionScope(value: unknown): value is ExecutionScope {
  if (typeof value !== "object" || value === null) return false;
  const scope = value as Record<string, unknown>;
  return (
    isNonEmptyIdentity(scope.connectionId) &&
    isRuntimeId(scope.runtime) &&
    isNonEmptyIdentity(scope.sessionId) &&
    isNonEmptyIdentity(scope.root)
  );
}

export function isDocumentKey(value: unknown): value is DocumentKey {
  if (typeof value !== "object" || value === null) return false;
  const key = value as Record<string, unknown>;
  return isExecutionScope(key.scope) && isNonEmptyIdentity(key.path);
}

function requireScope(scope: ExecutionScope): void {
  if (!isExecutionScope(scope)) throw new TypeError("Invalid execution scope");
}

export function executionScopeId(scope: ExecutionScope): string {
  requireScope(scope);
  return `scope:${JSON.stringify([scope.connectionId, scope.runtime, scope.sessionId, scope.root])}`;
}

export function documentKeyId(key: DocumentKey): string {
  if (!isDocumentKey(key)) throw new TypeError("Invalid document key");
  return `document:${JSON.stringify([
    key.scope.connectionId,
    key.scope.runtime,
    key.scope.sessionId,
    key.scope.root,
    key.path,
  ])}`;
}

export function sameExecutionScope(left: ExecutionScope, right: ExecutionScope): boolean {
  return (
    isExecutionScope(left) &&
    isExecutionScope(right) &&
    left.connectionId === right.connectionId &&
    left.runtime === right.runtime &&
    left.sessionId === right.sessionId &&
    left.root === right.root
  );
}

export function sameDocumentKey(left: DocumentKey, right: DocumentKey): boolean {
  return isDocumentKey(left) && isDocumentKey(right) && left.path === right.path && sameExecutionScope(left.scope, right.scope);
}

export function makeDocumentKey(scope: ExecutionScope, path: string): DocumentKey {
  requireScope(scope);
  if (!isNonEmptyIdentity(path)) throw new TypeError("Invalid document path");
  return { scope: { ...scope }, path };
}
