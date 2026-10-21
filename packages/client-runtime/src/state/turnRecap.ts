import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2TurnRecap,
  OrchestrationV2ThreadShell,
  ProviderRequestKind,
  RunId,
} from "@t3tools/contracts";

import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

import type { ThreadRunSummary, ThreadRuntimeSummary } from "./models.ts";
import type { ThreadCheckpointSummary } from "./threadCheckpoints.ts";
import type { PendingThreadRequests } from "./threadRequests.ts";

export type TurnRecapOutcome =
  | OrchestrationV2TurnRecap["outcome"]
  | "approval"
  | "failed"
  | "limited";

export interface TurnRecapChanges {
  readonly fileCount: number;
  readonly additions: number;
  readonly deletions: number;
}

export interface TurnRecap {
  readonly runId: RunId | null;
  readonly outcome: TurnRecapOutcome;
  /** What the agent is waiting on: the approval detail or the first question. */
  readonly request: string | null;
  readonly generated: OrchestrationV2TurnRecap | null;
  readonly changes: TurnRecapChanges | null;
}

export const TURN_RECAP_OUTCOME_LABELS: Record<TurnRecapOutcome, string> = {
  completed: "Completed",
  progress: "Progress made",
  waiting: "Waiting",
  blocked: "Blocked",
  input: "Needs input",
  approval: "Needs approval",
  failed: "Failed",
  limited: "Usage limit reached",
};

const APPROVAL_KIND_LABELS: Record<ProviderRequestKind, string> = {
  command: "Command approval",
  "file-read": "File read approval",
  "file-change": "File change approval",
  "mcp-elicitation": "App access approval",
  permission: "App permission approval",
};

function pendingRequestRecap(
  pendingRequests: PendingThreadRequests | null,
): Pick<TurnRecap, "outcome" | "request"> | null {
  const approval = pendingRequests?.approvals[0];
  if (approval !== undefined) {
    return {
      outcome: "approval",
      request: approval.detail ?? APPROVAL_KIND_LABELS[approval.requestKind],
    };
  }
  const userInput = pendingRequests?.userInputs[0];
  if (userInput !== undefined) {
    return { outcome: "input", request: userInput.questions[0]?.question ?? null };
  }
  return null;
}

/** Current requests and background work outrank the model's saved interpretation. */
export function deriveTurnRecap(input: {
  readonly working: boolean;
  readonly latestRun: Pick<ThreadRunSummary, "runId" | "status" | "recap"> | null;
  readonly runtime: Pick<ThreadRuntimeSummary, "lastErrorClass"> | null;
  readonly pendingRequests: PendingThreadRequests | null;
  readonly pendingBackgroundTasks?: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  readonly checkpoints: ReadonlyArray<Pick<ThreadCheckpointSummary, "runId" | "files">>;
}): TurnRecap | null {
  const { latestRun } = input;
  const pending = pendingRequestRecap(input.pendingRequests);
  const settled =
    !input.working && (latestRun?.status === "completed" || latestRun?.status === "failed");
  const generated = settled ? (latestRun?.recap ?? null) : null;
  let outcome: TurnRecapOutcome;
  if (pending) outcome = pending.outcome;
  else if (!settled) return null;
  else if (latestRun?.status === "failed") {
    outcome = input.runtime?.lastErrorClass === "usage_limit" ? "limited" : "failed";
  } else {
    if (!generated?.showCard) return null;
    outcome = backgroundWorkHoldsCompletion(input.pendingBackgroundTasks ?? [])
      ? "waiting"
      : generated.outcome === "completed" && generated.remainingWork !== null
        ? "progress"
        : generated.outcome;
  }
  const runId = latestRun?.runId ?? null;
  const files =
    runId === null
      ? []
      : (input.checkpoints.findLast((checkpoint) => checkpoint.runId === runId)?.files ?? []);
  return {
    runId,
    outcome,
    request: pending?.request ?? null,
    generated: pending ? null : generated,
    changes:
      files.length === 0
        ? null
        : {
            fileCount: files.length,
            additions: files.reduce((total, file) => total + file.additions, 0),
            deletions: files.reduce((total, file) => total + file.deletions, 0),
          },
  };
}

export function turnRecapPreview(thread: {
  readonly latestRun: Pick<ThreadRunSummary, "status"> | null;
  readonly source: Pick<OrchestrationV2ThreadShell, "latestRunRecapSummary">;
  readonly runtime: Pick<ThreadRuntimeSummary, "status"> | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
}): string | null {
  if (
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    (thread.runtime &&
      ["preparing", "starting", "running", "waiting"].includes(thread.runtime.status))
  )
    return null;
  const run = thread.latestRun;
  return run?.status === "completed" || run?.status === "failed"
    ? (thread.source.latestRunRecapSummary ?? null)
    : null;
}
