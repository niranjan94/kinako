import type {
  CommandId,
  MessageId,
  OrchestrationV2ConversationSummaryDirection,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";

const SUMMARIZABLE_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
]);

type SummaryProjection = Pick<OrchestrationV2ThreadProjection, "messages" | "runs">;

function userMessageRuns(projection: SummaryProjection) {
  const runsById = new Map(projection.runs.map((run) => [run.id, run]));
  return projection.messages.flatMap((message) => {
    const run = message.runId === null ? undefined : runsById.get(message.runId);
    return message.role === "user" && run !== undefined && run.status !== "rolled_back"
      ? [{ messageId: message.id, run }]
      : [];
  });
}

/**
 * User messages that "Summarize up to here" can start from: their turn is
 * still in the conversation and an earlier turn ran, as the server requires.
 */
export function conversationSummaryUpToHereMessageIds(
  projection: SummaryProjection | null | undefined,
): ReadonlySet<MessageId> {
  if (!projection) return new Set();
  let firstExecutedOrdinal = Number.POSITIVE_INFINITY;
  for (const run of projection.runs) {
    if (SUMMARIZABLE_RUN_STATUSES.has(run.status)) {
      firstExecutedOrdinal = Math.min(firstExecutedOrdinal, run.ordinal);
    }
  }
  return new Set(
    userMessageRuns(projection)
      .filter(({ run }) => run.ordinal > firstExecutedOrdinal)
      .map(({ messageId }) => messageId),
  );
}

/**
 * User messages that "Summarize from here" can rewind to: a ready checkpoint
 * marks the state after the last turn before theirs still in the conversation,
 * as the server requires.
 */
export function conversationSummaryFromHereMessageIds(
  projection:
    | (SummaryProjection & Pick<OrchestrationV2ThreadProjection, "checkpoints">)
    | null
    | undefined,
): ReadonlySet<MessageId> {
  if (!projection) return new Set();
  const readyOrdinals = new Set<number | "initial">();
  for (const checkpoint of projection.checkpoints) {
    if (checkpoint.status !== "ready") continue;
    if (checkpoint.appRunOrdinal !== null) readyOrdinals.add(checkpoint.appRunOrdinal);
    else if (checkpoint.ordinalWithinScope === 0) readyOrdinals.add("initial");
  }
  const liveOrdinals = projection.runs
    .filter((run) => run.status !== "rolled_back")
    .map((run) => run.ordinal)
    .sort((left, right) => left - right);
  const previousLiveOrdinal = (ordinal: number) => {
    let previous: number | "initial" = "initial";
    for (const candidate of liveOrdinals) {
      if (candidate >= ordinal) break;
      previous = candidate;
    }
    return previous;
  };
  return new Set(
    userMessageRuns(projection)
      .filter(
        ({ run }) =>
          SUMMARIZABLE_RUN_STATUSES.has(run.status) &&
          readyOrdinals.has(previousLiveOrdinal(run.ordinal)),
      )
      .map(({ messageId }) => messageId),
  );
}

export interface ConversationSummaryRequest {
  readonly requestId: CommandId;
  readonly messageId: MessageId;
  readonly direction: OrchestrationV2ConversationSummaryDirection;
  /** Summary markers that existed before the request, from `conversationSummaryMarkerIds`. */
  readonly existingMarkerIds: ReadonlySet<string>;
}

type SummaryOutcomeProjection = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | "messages" | "runs" | "turnItems"
>;

export function conversationSummaryMarkerIds(
  projection: Pick<OrchestrationV2ThreadProjection, "turnItems"> | null | undefined,
): ReadonlySet<string> {
  return new Set(
    projection?.turnItems.filter((item) => item.type === "compaction").map((item) => item.id),
  );
}

/**
 * How `request` ended: applied once its marker is in the timeline and, for
 * `from_here`, its message's run is rolled back; failed with the server's
 * reason; null while it is still running.
 */
export function conversationSummaryOutcome(
  projection: SummaryOutcomeProjection,
  request: ConversationSummaryRequest,
): { readonly type: "applied" } | { readonly type: "failed"; readonly message: string } | null {
  const summarize = projection.thread.summarize;
  if (summarize?.requestId === request.requestId && summarize.failure !== undefined) {
    return { type: "failed", message: summarize.failure };
  }
  // The server applies the summary, and requests a `from_here` rollback, under this command.
  const rollbackFailure = projection.thread.rollbackFailure;
  if (rollbackFailure?.requestId === `${request.requestId}:summary-complete`) {
    return { type: "failed", message: rollbackFailure.message };
  }
  const applied = projection.turnItems.some(
    (item) =>
      item.type === "compaction" &&
      item.range?.messageId === request.messageId &&
      !request.existingMarkerIds.has(item.id),
  );
  if (!applied) return null;
  if (request.direction === "up_to_here") return { type: "applied" };
  const runId = projection.messages.find((message) => message.id === request.messageId)?.runId;
  return projection.runs.some((run) => run.id === runId && run.status === "rolled_back")
    ? { type: "applied" }
    : null;
}
