import type {
  MessageId,
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
 * marks the state before their turn, as the server requires.
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
  return new Set(
    userMessageRuns(projection)
      .filter(
        ({ run }) =>
          SUMMARIZABLE_RUN_STATUSES.has(run.status) &&
          readyOrdinals.has(run.ordinal === 1 ? "initial" : run.ordinal - 1),
      )
      .map(({ messageId }) => messageId),
  );
}
