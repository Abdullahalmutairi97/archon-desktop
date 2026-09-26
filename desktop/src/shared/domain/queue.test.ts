import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { deriveQueueData, normalizeTaskView, queueCounts, queueLabel, type QueueData } from "./queue";

const require = createRequire(import.meta.url);
const legacy = require("../../../../current/queue-status-patch.cjs") as {
  ArchonQueueData: (data: Record<string, unknown>) => Record<string, unknown>;
  ArchonQueueCounts: (tasks: Array<{ state: string }>) => { running: number; queued: number };
  ArchonQueueLabel: (tasks: Array<{ state: string }>) => string;
};

describe("queue status projection", () => {
  it("normalizes durable and legacy envelopes while retaining attempt and recovery truth", () => {
    expect(normalizeTaskView({ id: "q", session_id: "s", status: "queued", current_attempt_id: null })).toEqual({
      id: "q", sessionId: "s", status: "queued", recoveryState: "none",
    });
    expect(normalizeTaskView({ task: { id: "r", session_id: "s", status: "cancelling", current_attempt_id: "attempt-1" } })).toEqual({
      id: "r", sessionId: "s", status: "cancel_requested", currentAttemptId: "attempt-1", recoveryState: "none",
    });
    expect(normalizeTaskView({
      id: "failed-after-restart",
      status: "failed",
      result: { recovery: { review_required: true, automatic_retry: false, side_effects: "unknown" } },
    })).toEqual({ id: "failed-after-restart", status: "failed", recoveryState: "review_required" });
    expect(normalizeTaskView({ id: "legacy", state: "surprising-new-state" }).status).toBe("unknown");
  });

  it("matches the frozen helper for running-over-queued precedence and aggregate counts", () => {
    const oldData = {
      sessions: [
        { id: "s", projectId: "p", state: "working", active: true },
        { id: "idle", projectId: "p", state: "done", active: true },
      ],
      tasks: [
        { id: "later", sessionId: "s", state: "queued" },
        { id: "active", sessionId: "s", state: "working" },
        { id: "project-follow-up", sessionId: "idle", state: "queued" },
      ],
      projects: [{ id: "p", running: 1 }],
      host: { connected: true },
    };
    const expected = legacy.ArchonQueueData(oldData) as {
      sessions: Array<{ id: string; state: string }>;
      projects: Array<{ id: string; running: number; queued: number }>;
      host: { running: number; queued: number };
    };
    const actual = deriveQueueData({
      ...oldData,
      tasks: oldData.tasks.map(normalizeTaskView),
    } as QueueData);

    expect(actual.sessions.map(({ id, state }) => [id, state])).toEqual(expected.sessions.map(({ id, state }) => [id, state]));
    expect(actual.projects.map(({ id, running, queued }) => [id, running, queued])).toEqual(
      expected.projects.map(({ id, running, queued }) => [id, running, queued]),
    );
    expect(actual.host).toMatchObject(expected.host);
    expect(oldData.sessions[0].state).toBe("working");
  });

  it("keeps recovery review and unknown activity out of running and success counts", () => {
    const tasks = [
      normalizeTaskView({ id: "needs-review", session_id: "review-s", status: "failed", recovery: { review_required: true } }),
      normalizeTaskView({ id: "unknown", session_id: "review-s", status: "future-state" }),
      normalizeTaskView({ id: "queued", session_id: "queued-s", status: "queued" }),
    ];
    expect(queueCounts(tasks)).toEqual({ running: 0, queued: 1 });
    expect(queueLabel(tasks)).toBe("0 running · 1 queued");
    const view = deriveQueueData({
      tasks,
      sessions: [{ id: "review-s", state: "working" }, { id: "queued-s", state: "done" }],
      projects: [],
      host: {},
    });
    expect(view.sessions[0].state).toBe("review");
    expect(view.sessions[1].state).toBe("queued");
    expect(view.host).toMatchObject({ running: 0, queued: 1 });
    expect(legacy.ArchonQueueCounts([{ state: "working" }, { state: "queued" }])).toEqual({ running: 1, queued: 1 });
    expect(legacy.ArchonQueueLabel([{ state: "working" }, { state: "queued" }])).toBe("1 running · 1 queued");
  });

  it("clears stale session activity for cancelled and unknown latest tasks", () => {
    const view = deriveQueueData({
      tasks: [
        normalizeTaskView({ id: "cancelled", session_id: "cancelled-s", status: "cancelled" }),
        normalizeTaskView({ id: "unknown", session_id: "unknown-s", status: "future-state" }),
      ],
      sessions: [
        { id: "cancelled-s", state: "working" },
        { id: "unknown-s", state: "done" },
      ],
      projects: [],
    });

    expect(view.sessions.map(({ state }) => state)).toEqual(["cancelled", "unknown"]);
  });
});
