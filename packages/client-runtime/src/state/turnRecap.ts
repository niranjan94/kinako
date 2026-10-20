import type { MessageId, ProviderRequestKind, RunId } from "@t3tools/contracts";

import type { ThreadRunSummary, ThreadRuntimeSummary } from "./models.ts";
import type { ThreadCheckpointSummary } from "./threadCheckpoints.ts";
import type { PendingThreadRequests } from "./threadRequests.ts";

export type TurnRecapOutcome = "completed" | "input" | "approval" | "failed" | "limited";

export interface TurnRecapChanges {
  readonly fileCount: number;
  readonly additions: number;
  readonly deletions: number;
}

export interface TurnRecapExcerpt {
  readonly text: string;
  /** The message says more than the excerpt, so the excerpt adds a summary rather than a copy. */
  readonly elided: boolean;
}

export interface TurnRecap {
  readonly runId: RunId | null;
  readonly outcome: TurnRecapOutcome;
  /** What the agent is waiting on: the approval detail or the first question. */
  readonly request: string | null;
  readonly finalMessage: TurnRecapExcerpt | null;
  readonly changes: TurnRecapChanges | null;
}

export const TURN_RECAP_OUTCOME_LABELS: Record<TurnRecapOutcome, string> = {
  completed: "Completed",
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

const FINAL_MESSAGE_EXCERPT_MAX_LENGTH = 280;
const FENCED_CODE_BLOCK = /```[\s\S]*?(?:```|$)/g;
const MARKDOWN_LINK = /!?\[([^\]\n]*)\]\([^)\n]*\)/g;
const HEADING_LINE = /^\s*#{1,6}\s/;
const LINE_MARKER = /^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/;
const INLINE_EMPHASIS = /\*\*|__|`/g;

/** The opening prose of an assistant message as plain text, capped for a one-glance read. */
export function turnRecapMessageExcerpt(text: string): TurnRecapExcerpt | null {
  const paragraphs = text
    .replace(FENCED_CODE_BLOCK, "\n\n")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.split("\n").filter((line) => line.trim() !== ""))
    .filter((paragraph) => paragraph.length > 0);
  // Headings like "## Summary" say nothing about the turn, so prefer the prose under them.
  const proseLines =
    paragraphs
      .map((paragraph) => paragraph.filter((line) => !HEADING_LINE.test(line)))
      .find((paragraph) => paragraph.length > 0) ?? paragraphs[0];
  if (proseLines === undefined) return null;
  const plain = proseLines
    .map((line) => line.replace(LINE_MARKER, ""))
    .join(" ")
    .replace(MARKDOWN_LINK, "$1")
    .replace(INLINE_EMPHASIS, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain === "") return null;
  if (plain.length > FINAL_MESSAGE_EXCERPT_MAX_LENGTH) {
    return {
      text: `${plain.slice(0, FINAL_MESSAGE_EXCERPT_MAX_LENGTH - 1).trimEnd()}…`,
      elided: true,
    };
  }
  return { text: plain, elided: paragraphs.length > 1 || text.includes("```") };
}

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

function settledRunOutcome(
  latestRun: Pick<ThreadRunSummary, "status">,
  runtime: Pick<ThreadRuntimeSummary, "lastErrorClass"> | null,
): TurnRecapOutcome | null {
  if (latestRun.status === "completed") return "completed";
  if (latestRun.status === "failed") {
    return runtime?.lastErrorClass === "usage_limit" ? "limited" : "failed";
  }
  return null;
}

/**
 * Summarizes the latest turn once it stops for the user. Interrupted, cancelled,
 * and still-running turns have no recap: the user either caused the stop or the
 * agent is not waiting on them yet.
 */
export function deriveTurnRecap(input: {
  /** Work is underway, including a just-sent message whose run does not exist yet. */
  readonly working: boolean;
  readonly latestRun: Pick<ThreadRunSummary, "runId" | "status" | "assistantMessageId"> | null;
  readonly runtime: Pick<ThreadRuntimeSummary, "lastErrorClass"> | null;
  readonly pendingRequests: PendingThreadRequests | null;
  readonly messages: ReadonlyArray<{ readonly id: MessageId; readonly text: string }>;
  readonly checkpoints: ReadonlyArray<Pick<ThreadCheckpointSummary, "runId" | "files">>;
}): TurnRecap | null {
  const { latestRun } = input;
  const pending = pendingRequestRecap(input.pendingRequests);
  const outcome =
    pending?.outcome ??
    (latestRun === null || input.working ? null : settledRunOutcome(latestRun, input.runtime));
  if (outcome === null) return null;

  const runId = latestRun?.runId ?? null;
  const assistantMessageId = latestRun?.assistantMessageId ?? null;
  const finalMessageText =
    assistantMessageId === null
      ? undefined
      : input.messages.findLast((message) => message.id === assistantMessageId)?.text;
  const files =
    runId === null
      ? []
      : (input.checkpoints.findLast((checkpoint) => checkpoint.runId === runId)?.files ?? []);

  return {
    runId,
    outcome,
    request: pending?.request ?? null,
    finalMessage: finalMessageText === undefined ? null : turnRecapMessageExcerpt(finalMessageText),
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
