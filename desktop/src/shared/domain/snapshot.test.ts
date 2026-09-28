import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import {
  createSnapshotV1,
  encodeSnapshotV1,
  parseSnapshotV1,
  SNAPSHOT_MAX_BYTES,
  SNAPSHOT_PREFIX,
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

  it("produces and opens the exact codes of the v0.3.0 app in both directions", () => {
    // Produced by current/collab-model.cjs (the owner's v0.3.0 sharing model).
    const v030Code = "archon-snapshot:eyJ0eXBlIjoiYXJjaG9uLWNvbGxhYiIsInZlcnNpb24iOjIsImtpbmQiOiJzZXNzaW9uIiwidGl0bGUiOiJQbGFuINmF2LHYrdio2KciLCJzZXNzaW9ucyI6W3siaWQiOiJwcmltZS1hYmMiLCJ0aXRsZSI6IlBsYW4iLCJtZXNzYWdlcyI6W3sicm9sZSI6InVzZXIiLCJjb250ZW50IjoiSGkg8J+MjSJ9LHsicm9sZSI6ImFnZW50IiwiY29udGVudCI6IioqRG9uZSoqIn1dfV19";
    const source = [{ id: "prime-abc", title: "Plan", messages: [
      { role: "user", content: "Hi 🌍" },
      { role: "assistant", content: "**Done**" },
      { role: "agent", nativeKind: "thinking", content: "x" },
    ] }];
    const created = createSnapshotV1("session", "Plan مرحبا", source);
    expect(encodeSnapshotV1(created)).toBe(v030Code);
    expect(encodeSnapshotV1(created)).toBe(legacy.encode(legacy.create("session", "Plan مرحبا", source)));
    expect(parseSnapshotV1(v030Code)).toEqual(created);
    expect(parseSnapshotV1(`  ${v030Code}\n`)).toEqual(created);
    expect(legacy.parse(encodeSnapshotV1(created))).toEqual(created);
  });

  it("rejects tampered, truncated, foreign and oversized codes with one safe message", () => {
    const code = encodeSnapshotV1(createSnapshotV1("session", "T", [{ id: "s", title: "S", messages: [{ role: "user", content: "hi" }] }]));
    const payload = code.slice(SNAPSHOT_PREFIX.length);
    const reencode = (value: unknown) => `${SNAPSHOT_PREFIX}${btoa(JSON.stringify(value))}`;
    for (const bad of [
      "",
      payload,
      `archon-peer:${payload}`,
      code.slice(0, -7),
      `${code.slice(0, -4)}!!!!`,
      reencode({ type: "archon-collab", version: 3, kind: "session", title: "T", sessions: [] }),
      reencode({ type: "archon-collab", version: 2, kind: "session", title: "T", sessions: [{ id: "s", title: "S", messages: [{ role: "system", content: "x" }] }] }),
      reencode({ type: "archon-collab", version: 2, kind: "session", title: "T", sessions: [{ id: "s", title: "S", messages: [{ role: "user", content: { html: "<b>" } }] }] }),
      reencode({ type: "archon-collab", version: 2, kind: "session", title: "x".repeat(501), sessions: [{ id: "s", title: "S", messages: [] }] }),
      `${SNAPSHOT_PREFIX}${btoa(String.fromCharCode(0xff, 0xfe, 0x7b))}`,
      `${SNAPSHOT_PREFIX}${"A".repeat(SNAPSHOT_MAX_BYTES * 2)}`,
      42,
    ]) {
      expect(() => parseSnapshotV1(bad)).toThrow("Invalid or oversized sharing code.");
    }
  });
});
