import type { ThreadPullRequestWatch } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { pullRequestAutoFixStatus, pullRequestAutoFixToggle } from "./pullRequestAutoFix.ts";

const enabledAt = "2026-10-02T12:00:00.000Z";

const watch = (autoFix?: ThreadPullRequestWatch["autoFix"]): ThreadPullRequestWatch => ({
  startedAt: enabledAt,
  headSha: null,
  failedChecks: [],
  passed: false,
  passedChecks: [],
  remarksThrough: "2026-10-02T12:00:00.000Z",
  remarkIds: [],
  conflicting: false,
  wakes: 0,
  ...(autoFix === undefined ? {} : { autoFix }),
});

describe("pullRequestAutoFix", () => {
  it("offers to turn auto-fix on for an unwatched or plainly watched pull request", () => {
    expect(pullRequestAutoFixStatus(undefined)).toBeNull();
    expect(pullRequestAutoFixStatus(watch())).toBeNull();
    expect(pullRequestAutoFixToggle(watch())).toEqual({ label: "Auto-fix CI", autoFix: true });
  });

  it("counts attempts while fixing and offers to stop", () => {
    const fixing = watch({ enabledAt, attempts: 2, pausedReason: null, fixMessageId: null });
    expect(pullRequestAutoFixStatus(fixing)).toEqual({
      paused: false,
      label: "Auto-fixing CI",
      description: "Fix attempt 2 of 3 since checks last passed.",
    });
    expect(pullRequestAutoFixToggle(fixing)).toEqual({
      label: "Stop auto-fixing CI",
      autoFix: false,
    });
  });

  it("explains each pause and offers to resume", () => {
    for (const [pausedReason, reason] of [
      ["attempt-limit", "after 3 fix attempts"],
      ["no-push", "without pushing a commit"],
    ] as const) {
      const paused = watch({ enabledAt, attempts: 3, pausedReason, fixMessageId: null });
      expect(pullRequestAutoFixStatus(paused)?.paused).toBe(true);
      expect(pullRequestAutoFixStatus(paused)?.description).toContain(reason);
      expect(pullRequestAutoFixToggle(paused)).toEqual({
        label: "Resume auto-fix CI",
        autoFix: true,
      });
    }
  });
});
