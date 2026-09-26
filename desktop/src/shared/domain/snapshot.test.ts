import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import {
  createSnapshotV1,
  encodeSnapshotV1,
  parseSnapshotV1,
  SNAPSHOT_MAX_BYTES,
  validateSnapshotV1,
} from "./snapshot";

const require = createRequire(import.meta.url);
const legacy = require("../../../../current/collab-model.cjs") as {
  MAX: number;
  create: (kind: "session" | "project", title: string, sessions: unknown[]) => unknown;
  validate: (input: unknown) => unknown;
  encode: (input: unknown) => string;
  parse: (input: unknown) => unknown;
};

describe("read-only snapshot contract", () => {
  it("matches the existing selected-session filtering and version-2 envelope", () => {
    const selected = [{
      id: "session-a",
      title: "Hello",
      token: "sentinel-extra",
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello 🌍" },
        { role: "agent", nativeKind: "thinking", content: "private" },
        { role: "agent", nativeKind: "tool", content: "write_file" },
        { role: "system", content: "hidden" },
      ],
    }];
    const current = createSnapshotV1("project", "Project", selected);
    const expected = legacy.create("project", "Project", selected);

    expect(current).toEqual(expected);
    expect(current.version).toBe(2);
    expect(JSON.stringify(current)).not.toContain("sentinel-extra");
    expect(parseSnapshotV1(encodeSnapshotV1(current))).toEqual(current);
  });

  it("strips unknown fields and rejects malformed, sparse, oversized, or invalid UTF-8 input", () => {
    const envelope = {
      type: "archon-collab",
      version: 2,
      kind: "session",
      title: "Share",
      ignored: "extra",
      sessions: [{ id: "s", title: "Session", messages: [{ role: "agent", content: "code", token: "private" }] }],
    };
    expect(validateSnapshotV1(envelope)).toEqual(legacy.validate(envelope));
    expect(JSON.stringify(validateSnapshotV1(envelope))).not.toContain("private");
    expect(() => validateSnapshotV1({ ...envelope, version: 1 })).toThrow(/invalid/i);
    expect(() => validateSnapshotV1({ ...envelope, sessions: Array(1) })).toThrow(/invalid/i);
    expect(() => validateSnapshotV1({
      ...envelope,
      sessions: [{ id: "s", title: "Session", messages: [{ role: "agent", content: "界".repeat(SNAPSHOT_MAX_BYTES) }] }],
    })).toThrow(/oversized/i);
    expect(() => parseSnapshotV1("archon-snapshot:%%%" )).toThrow(/invalid/i);
    expect(SNAPSHOT_MAX_BYTES).toBe(legacy.MAX);
  });

  it("keeps UTF-8 byte limits and selected-session defaults", () => {
    const source = [{ id: "s", messages: [{ role: "assistant", content: "short" }] }];
    expect(createSnapshotV1("session", "Title", source)).toEqual(legacy.create("session", "Title", source));
    const oversized = {
      type: "archon-collab",
      version: 2,
      kind: "session",
      title: "Title",
      sessions: [{ id: "s", title: "Session", messages: [{ role: "agent", content: "界".repeat(Math.floor(SNAPSHOT_MAX_BYTES / 2)) }] }],
    };
    expect(JSON.stringify(oversized).length).toBeLessThan(SNAPSHOT_MAX_BYTES);
    expect(() => validateSnapshotV1(oversized)).toThrow(/oversized/i);
  });
});
