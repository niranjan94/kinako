import { describe, expect, it } from "vite-plus/test";
import {
  RunId,
  type OrchestrationV2TurnRecap,
  type OrchestrationV2RunStatus,
} from "@t3tools/contracts";

import { deriveTurnRecap, turnRecapPreview } from "./turnRecap.ts";

const generated: OrchestrationV2TurnRecap = {
  outcome: "completed",
  summary: "Fixed reconnect failures after sleep.",
  verification: "Reconnect tests pass.",
  remainingWork: null,
  nextAction: null,
  showCard: true,
};
const baseInput = {
  working: false,
  latestRun: {
    runId: RunId.make("run-1"),
    status: "completed" as OrchestrationV2RunStatus,
    recap: generated,
  },
  runtime: null,
  pendingRequests: null,
  checkpoints: [],
};

describe("deriveTurnRecap", () => {
  it("shows a saved synthesis with the turn's change totals", () => {
    const recap = deriveTurnRecap({
      ...baseInput,
      checkpoints: [
        {
          runId: RunId.make("run-1"),
          files: [
            { path: "a.ts", kind: "modified", additions: 3, deletions: 1 },
            { path: "b.ts", kind: "added", additions: 10, deletions: 0 },
          ],
        },
      ],
    });
    expect(recap?.generated).toEqual(generated);
    expect(recap?.changes).toEqual({ fileCount: 2, additions: 13, deletions: 1 });
  });

  it("does not label an ended provider turn completed while a summary is absent", () => {
    expect(
      deriveTurnRecap({
        ...baseInput,
        latestRun: { runId: RunId.make("run-1"), status: "completed" },
      }),
    ).toBeNull();
  });

  it("omits a redundant branch-switch recap even when the checkpoint has changes", () => {
    const recap = {
      ...generated,
      summary: "Switched to PR #2237; working tree clean.",
      showCard: false,
    };
    expect(
      deriveTurnRecap({
        ...baseInput,
        latestRun: { ...baseInput.latestRun, recap },
        checkpoints: [
          {
            runId: RunId.make("run-1"),
            files: [{ path: "branch.ts", kind: "modified", additions: 4700, deletions: 4900 }],
          },
        ],
      }),
    ).toBeNull();
  });

  it("uses the task outcome even though the provider run completed", () => {
    for (const outcome of ["progress", "waiting", "input", "blocked"] as const) {
      expect(
        deriveTurnRecap({
          ...baseInput,
          latestRun: { ...baseInput.latestRun, recap: { ...generated, outcome } },
        })?.outcome,
      ).toBe(outcome);
    }
  });

  it("does not show completed when the generated recap still lists unfinished work", () => {
    expect(
      deriveTurnRecap({
        ...baseInput,
        latestRun: {
          ...baseInput.latestRun,
          recap: { ...generated, remainingWork: "Fix the SQLite failure." },
        },
      })?.outcome,
    ).toBe("progress");
  });

  it("cannot show completed while a PR monitor is still active", () => {
    expect(
      deriveTurnRecap({
        ...baseInput,
        pendingBackgroundTasks: [
          { taskId: "pr:56", kind: "monitor", description: "Watching PR #56", awaited: true },
        ],
      })?.outcome,
    ).toBe("waiting");
  });

  it("completes while only a monitor the agent does not wait on is running", () => {
    expect(
      deriveTurnRecap({
        ...baseInput,
        pendingBackgroundTasks: [
          { taskId: "dev-server", kind: "monitor", description: "Watch dev server" },
        ],
      })?.outcome,
    ).toBe("completed");
  });

  it("puts pending approvals ahead of generated outcomes and pending questions", () => {
    const recap = deriveTurnRecap({
      ...baseInput,
      working: true,
      pendingRequests: {
        approvals: [{ requestKind: "command", detail: "pnpm test" }],
        userInputs: [{ questions: [{ question: "Which branch?" }] }],
      } as never,
    });
    expect(recap?.outcome).toBe("approval");
    expect(recap?.request).toBe("pnpm test");
    expect(recap?.generated).toBeNull();
  });

  it("shows pending questions immediately without waiting for generation", () => {
    const recap = deriveTurnRecap({
      ...baseInput,
      latestRun: { runId: RunId.make("run-1"), status: "waiting" },
      pendingRequests: {
        approvals: [],
        userInputs: [{ questions: [{ question: "Which branch?" }] }],
      } as never,
    });
    expect(recap?.outcome).toBe("input");
    expect(recap?.request).toBe("Which branch?");
  });

  it("keeps provider failures authoritative over generated success", () => {
    const input = {
      ...baseInput,
      latestRun: { ...baseInput.latestRun, status: "failed" as const },
    };
    expect(deriveTurnRecap(input)?.outcome).toBe("failed");
    expect(deriveTurnRecap({ ...input, runtime: { lastErrorClass: "usage_limit" } })?.outcome).toBe(
      "limited",
    );
  });

  it("hides recaps while working, after a new send, and after user stops or rollback", () => {
    for (const status of ["running", "interrupted", "cancelled", "rolled_back"] as const) {
      expect(
        deriveTurnRecap({ ...baseInput, latestRun: { ...baseInput.latestRun, status } }),
      ).toBeNull();
    }
    expect(deriveTurnRecap({ ...baseInput, latestRun: null })).toBeNull();
    expect(deriveTurnRecap({ ...baseInput, working: true })).toBeNull();
  });
});

describe("turnRecapPreview", () => {
  const thread = {
    source: { latestRunRecapSummary: generated.summary },
    latestRun: { ...baseInput.latestRun, recap: { ...generated, showCard: false } },
    runtime: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
  };
  it("keeps useful list previews for turns that do not need another conversation card", () => {
    expect(turnRecapPreview(thread)).toBe(generated.summary);
  });
  it("hides a stale preview when new work or a request needs attention", () => {
    expect(turnRecapPreview({ ...thread, runtime: { status: "running" } })).toBeNull();
    expect(turnRecapPreview({ ...thread, hasPendingUserInput: true })).toBeNull();
    expect(turnRecapPreview({ ...thread, hasPendingApprovals: true })).toBeNull();
    expect(turnRecapPreview({ ...thread, latestRun: { status: "rolled_back" } })).toBeNull();
  });
});
