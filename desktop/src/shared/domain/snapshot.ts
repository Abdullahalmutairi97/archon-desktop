/**
 * Read-only collaboration snapshot contract.
 *
 * Origin: `current/collab-model.cjs` (SHA-256
 * d164290431ac0d975d76b6518df5a4c12afe02c573a78334ade078ceccfd1291).
 * Transformation: CommonJS closure helpers became typed pure functions; the
 * existing version-2 wire envelope and validation limits remain unchanged.
 */

export const SNAPSHOT_MAX_BYTES = 1024 * 1024;
export const SNAPSHOT_PREFIX = "archon-snapshot:";

export type SnapshotKind = "session" | "project";

export interface SnapshotMessage {
  role: "user" | "agent";
  content: string;
}

export interface SnapshotSession {
  id: string;
  title: string;
  messages: SnapshotMessage[];
}

/** `SnapshotV1` names this authored API; the frozen collaboration wire version remains 2. */
export interface SnapshotV1 {
  type: "archon-collab";
  version: 2;
  kind: SnapshotKind;
  title: string;
  sessions: SnapshotSession[];
}

export interface SnapshotSourceMessage {
  role?: unknown;
  content?: unknown;
  nativeKind?: unknown;
}

export interface SnapshotSourceSession {
  id?: unknown;
  title?: unknown;
  messages?: readonly SnapshotSourceMessage[] | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(): never {
  throw new Error("Invalid or oversized sharing code.");
}

function isStringWithin(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

function serializedByteLength(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    if (typeof json !== "string") return Number.POSITIVE_INFINITY;
    return new TextEncoder().encode(json).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Validate untrusted input and return a normalized copy with no extra fields. */
export function validateSnapshotV1(value: unknown): SnapshotV1 {
  if (
    !isRecord(value) ||
    value.type !== "archon-collab" ||
    value.version !== 2 ||
    (value.kind !== "session" && value.kind !== "project") ||
    !isStringWithin(value.title, 500) ||
    !Array.isArray(value.sessions) ||
    value.sessions.length === 0 ||
    value.sessions.length > 100
  ) {
    return fail();
  }
  if (serializedByteLength(value) > SNAPSHOT_MAX_BYTES) return fail();

  const sessions: SnapshotSession[] = Array.from(value.sessions, (rawSession) => {
    if (
      !isRecord(rawSession) ||
      !isStringWithin(rawSession.id, 500) ||
      !isStringWithin(rawSession.title, 500) ||
      !Array.isArray(rawSession.messages) ||
      rawSession.messages.length > 2000
    ) {
      return fail();
    }
    const messages: SnapshotMessage[] = Array.from(rawSession.messages, (rawMessage) => {
      if (
        !isRecord(rawMessage) ||
        (rawMessage.role !== "user" && rawMessage.role !== "agent") ||
        !isStringWithin(rawMessage.content, SNAPSHOT_MAX_BYTES)
      ) {
        return fail();
      }
      return { role: rawMessage.role, content: rawMessage.content };
    });
    return { id: rawSession.id, title: rawSession.title, messages };
  });

  return {
    type: "archon-collab",
    version: 2,
    kind: value.kind,
    title: value.title,
    sessions,
  };
}

export function createSnapshotV1(
  kind: SnapshotKind,
  title: string,
  selectedSessions: readonly SnapshotSourceSession[],
): SnapshotV1 {
  if (!Array.isArray(selectedSessions) || selectedSessions.length === 0) {
    throw new Error("Choose a session or a project with sessions first.");
  }
  const source = selectedSessions.map((session) => {
    const sourceMessages = session.messages || [];
    if (!Array.isArray(sourceMessages)) return fail();
    const messages = sourceMessages
      .filter((message) => {
        if (!isRecord(message)) return false;
        return !message.nativeKind && ["user", "agent", "assistant"].includes(String(message.role));
      })
      .map((message) => ({
        role: message.role === "assistant" ? "agent" : message.role,
        content: message.content || "",
      }));
    return {
      id: session.id,
      title: session.title || "Untitled session",
      messages,
    };
  });
  return validateSnapshotV1({ type: "archon-collab", version: 2, kind, title, sessions: source });
}

export function encodeSnapshotV1(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(validateSnapshotV1(value)));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `${SNAPSHOT_PREFIX}${btoa(binary)}`;
}

export function parseSnapshotV1(input: unknown): SnapshotV1 {
  if (!isStringWithin(input, SNAPSHOT_MAX_BYTES * 2)) return fail();
  const raw = input.trim();
  if (!raw.startsWith(SNAPSHOT_PREFIX)) return fail();
  try {
    const binary = atob(raw.slice(SNAPSHOT_PREFIX.length));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return validateSnapshotV1(JSON.parse(decoded) as unknown);
  } catch {
    return fail();
  }
}
