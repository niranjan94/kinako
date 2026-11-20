import type {
  OrchestrationV2AppThread,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  ProviderAdapterRuntimeMode,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * What a reviewer model sees, split by trust. Tool output, file contents, reasoning, and other
 * text the agent could have planted stay out; only the user's words are `trustedUserIntent`.
 */
export interface ReviewBundle {
  readonly trustedUserIntent: {
    readonly threadTitle: string;
    readonly recentUserMessages: ReadonlyArray<string>;
    readonly answeredQuestions: ReadonlyArray<string>;
    readonly delegatedTask?: string;
    readonly recentManualApprovals: ReadonlyArray<string>;
  };
  readonly approvedPlanOrLastAssistantProposal?: string;
  readonly workspace: {
    readonly cwd: string;
    readonly additionalDirectories: ReadonlyArray<string>;
    readonly isWorktree: boolean;
    readonly branch: string | null;
    readonly provider: string;
    readonly baseMode: ProviderAdapterRuntimeMode;
    readonly escalatedFromNativeAuto: boolean;
  };
  readonly proposedAction: {
    readonly requestKind: OrchestrationV2RuntimeRequest["kind"];
    readonly toolName?: string;
    readonly command?: string;
    readonly paths?: ReadonlyArray<{ readonly path: string; readonly insideWorkspace: boolean }>;
    readonly toolInputSummary?: string;
    readonly providerReason?: string;
    readonly recentActionTitles: ReadonlyArray<string>;
  };
}

const USER_MESSAGES = 8;
const USER_MESSAGES_MAX_CHARS = 4_000;
const REFERENCE_MAX_CHARS = 2_000;
const ITEM_TEXT_MAX_CHARS = 400;

const clip = (text: string, max: number) => {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
};

/** The newest texts that fit the budget, oldest first. */
const newestWithin = (texts: ReadonlyArray<string>, count: number, budget: number) => {
  const kept: Array<string> = [];
  let used = 0;
  for (const text of texts.toReversed().slice(0, count)) {
    const clipped = clip(text, Math.max(0, budget - used));
    if (clipped.length === 0) break;
    kept.unshift(clipped);
    used += clipped.length;
  }
  return kept;
};

const approvalSummary = (request: OrchestrationV2RuntimeRequest) =>
  clip(
    request.inspection?.command ??
      request.inspection?.paths?.join(", ") ??
      request.inspection?.toolName ??
      request.kind,
    ITEM_TEXT_MAX_CHARS,
  );

export function buildReviewBundle(input: {
  readonly thread: OrchestrationV2AppThread;
  readonly records: Pick<
    OrchestrationV2ThreadProjection,
    "messages" | "runtimeRequests" | "plans" | "turnItems"
  >;
  readonly request: OrchestrationV2RuntimeRequest;
  readonly approvalItem: Extract<OrchestrationV2TurnItem, { type: "approval_request" }> | undefined;
  readonly delegatedTask: string | undefined;
  readonly cwd: string;
  readonly additionalDirectories: ReadonlyArray<string>;
  readonly paths: ReadonlyArray<{ readonly path: string; readonly insideWorkspace: boolean }>;
  readonly provider: string;
  readonly baseMode: ProviderAdapterRuntimeMode;
}): ReviewBundle {
  const { records, request } = input;
  const userMessages = records.messages.filter(
    (message) => message.role === "user" && message.createdBy === "user",
  );
  const lastUserAt = userMessages.at(-1)?.createdAt;
  const lastAssistant = records.messages.findLast(
    (message) =>
      message.role === "assistant" &&
      (lastUserAt === undefined ||
        DateTime.toEpochMillis(message.createdAt) < DateTime.toEpochMillis(lastUserAt)),
  );
  const plan = records.plans.findLast(
    (candidate) => candidate.kind === "proposed_plan" && candidate.status !== "superseded",
  );
  const reference =
    plan?.kind === "proposed_plan"
      ? plan.markdown
      : lastAssistant === undefined
        ? undefined
        : lastAssistant.text;
  const resolved = records.runtimeRequests.filter(
    (candidate) => candidate.status === "resolved" && candidate.id !== request.id,
  );
  const answeredQuestions = resolved
    .filter((candidate) => candidate.kind === "user_input" && candidate.answers !== undefined)
    .slice(-3)
    .map((candidate) => clip(JSON.stringify(candidate.answers), ITEM_TEXT_MAX_CHARS));
  const recentManualApprovals = resolved
    .filter(
      (candidate) =>
        candidate.kind !== "user_input" &&
        candidate.autoReview?.state !== "approved" &&
        candidate.decision !== undefined,
    )
    .slice(-5)
    .map((candidate) => `${candidate.decision}: ${approvalSummary(candidate)}`);
  const recentActionTitles = records.turnItems
    .flatMap((item) => (item.title === null ? [] : [clip(item.title, 120)]))
    .slice(-10);
  const inspection = request.inspection;
  const command =
    inspection?.command ?? (request.kind === "command" ? input.approvalItem?.prompt : undefined);
  return {
    trustedUserIntent: {
      threadTitle: input.thread.title,
      recentUserMessages: newestWithin(
        userMessages.map((message) => message.text),
        USER_MESSAGES,
        USER_MESSAGES_MAX_CHARS,
      ),
      answeredQuestions,
      ...(input.delegatedTask === undefined
        ? {}
        : { delegatedTask: clip(input.delegatedTask, USER_MESSAGES_MAX_CHARS) }),
      recentManualApprovals,
    },
    ...(reference === undefined
      ? {}
      : { approvedPlanOrLastAssistantProposal: clip(reference, REFERENCE_MAX_CHARS) }),
    workspace: {
      cwd: input.cwd,
      additionalDirectories: input.additionalDirectories,
      isWorktree: input.thread.worktreePath !== null,
      branch: input.thread.branch,
      provider: input.provider,
      baseMode: input.baseMode,
      escalatedFromNativeAuto: input.baseMode === "auto",
    },
    proposedAction: {
      requestKind: request.kind,
      ...(inspection?.toolName === undefined ? {} : { toolName: inspection.toolName }),
      ...(command === undefined ? {} : { command: clip(command, 4_000) }),
      ...(input.paths.length === 0 ? {} : { paths: input.paths }),
      ...(inspection?.toolInputSummary === undefined
        ? {}
        : { toolInputSummary: inspection.toolInputSummary }),
      ...(input.approvalItem?.reason === undefined
        ? {}
        : { providerReason: clip(input.approvalItem.reason, ITEM_TEXT_MAX_CHARS) }),
      recentActionTitles,
    },
  };
}
