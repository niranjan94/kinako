import type {
  OrchestrationV2ConversationSummaryDirection,
  OrchestrationV2HistoricalMessage,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { historicalMessage } from "@t3tools/provider-core/server/handoffBudget";

const SUMMARIZABLE_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
]);

const MAX_TRANSCRIPT_ITEM_CHARS = 6_000;
const MAX_TRANSCRIPT_CHARS = 400_000;

/** Whether `run` settled and is still part of the provider conversation. */
export function isSummarizableRun(run: OrchestrationV2Run): boolean {
  return SUMMARIZABLE_RUN_STATUSES.has(run.status);
}

/** Runs whose provider context a summary at `messageRun` replaces, oldest first. */
export function conversationSummaryCoveredRuns(
  runs: ReadonlyArray<OrchestrationV2Run>,
  messageRun: OrchestrationV2Run,
  direction: OrchestrationV2ConversationSummaryDirection,
): ReadonlyArray<OrchestrationV2Run> {
  return runs
    .filter(
      (run) =>
        isSummarizableRun(run) &&
        (direction === "from_here"
          ? run.ordinal >= messageRun.ordinal
          : run.ordinal < messageRun.ordinal),
    )
    .toSorted((left, right) => left.ordinal - right.ordinal);
}

function transcriptEntry(item: OrchestrationV2TurnItem): string | null {
  const message = historicalMessage(item);
  if (message === null || message.text.trim().length === 0) return null;
  const label =
    item.type === "user_message"
      ? "User"
      : item.type === "assistant_message"
        ? "Agent"
        : `Agent (${item.type.replaceAll("_", " ")})`;
  const text =
    message.text.length > MAX_TRANSCRIPT_ITEM_CHARS
      ? `${message.text.slice(0, MAX_TRANSCRIPT_ITEM_CHARS)}\n[truncated]`
      : message.text;
  return `${label}:\n${text}`;
}

/**
 * The covered items as a plain transcript for the summarizer. A transcript
 * over the limit keeps its opening and its end, where goals and the latest
 * state live, and marks what it dropped between them.
 */
export function renderConversationSummaryTranscript(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): string {
  const entries = items.flatMap((item) => transcriptEntry(item) ?? []);
  const total = entries.reduce((sum, entry) => sum + entry.length + 2, 0);
  if (total <= MAX_TRANSCRIPT_CHARS) return entries.join("\n\n");
  const half = MAX_TRANSCRIPT_CHARS / 2;
  const head: Array<string> = [];
  let headChars = 0;
  for (const entry of entries) {
    if (headChars + entry.length > half) break;
    head.push(entry);
    headChars += entry.length + 2;
  }
  const tail: Array<string> = [];
  let tailChars = 0;
  for (let index = entries.length - 1; index >= head.length; index--) {
    const entry = entries[index]!;
    if (tailChars + entry.length > half) break;
    tail.unshift(entry);
    tailChars += entry.length + 2;
  }
  const omitted = entries.length - head.length - tail.length;
  return [...head, `[${omitted} items omitted]`, ...tail].join("\n\n");
}

/** The summary as handoff history, attributed to the compaction item that shows it. */
export function conversationSummaryHistoricalMessage(input: {
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
  readonly direction: OrchestrationV2ConversationSummaryDirection;
  readonly summary: string;
}): OrchestrationV2HistoricalMessage {
  const preface =
    input.direction === "from_here"
      ? "The user replaced the end of this conversation with the summary below. Those turns are no longer in your context. Continue from the summary."
      : "The user replaced the opening of this conversation with the summary below. The turns after it follow verbatim.";
  return {
    role: "user",
    text: `${preface}\n\n${input.summary}`,
    threadId: input.threadId,
    runId: null,
    itemId: input.itemId,
    providerThreadId: null,
    status: "completed",
    kind: "conversation_summary",
  };
}
