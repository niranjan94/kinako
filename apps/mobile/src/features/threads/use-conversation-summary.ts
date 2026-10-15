import {
  conversationSummaryFromHereMessageIds,
  conversationSummaryUpToHereMessageIds,
} from "@t3tools/client-runtime/state/conversationSummary";
import {
  CommandId,
  type EnvironmentId,
  type MessageId,
  type OrchestrationV2ConversationSummaryDirection,
  type ServerProvider,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Platform } from "react-native";

import { showTextInputDialog } from "../../components/ConfirmDialogHost";
import { useAtomCommand } from "../../state/use-atom-command";
import { flushComposerDrafts, mergeComposerDraftContent } from "../../state/use-composer-drafts";
import { useThreadProjection } from "../../state/use-thread-detail";
import { threadEnvironment } from "../../state/threads";
import { uuidv4 } from "../../lib/uuid";

/** What the feed needs to offer and show conversation summaries. */
export interface ConversationSummaryFeedControls {
  readonly summarize: (
    messageId: MessageId,
    direction: OrchestrationV2ConversationSummaryDirection,
  ) => void;
  readonly restore: (turnItemId: TurnItemId) => void;
  /** Why "from here" is unavailable for a message, or null when it is offered. */
  readonly fromHereUnavailableReason: (messageId: MessageId) => string | null;
  readonly upToHereUnavailableReason: (messageId: MessageId) => string | null;
  readonly activeProviderThreadId: string | null;
  readonly busy: boolean;
}

interface PendingSummary {
  readonly requestId: CommandId;
  readonly messageId: MessageId;
  readonly direction: OrchestrationV2ConversationSummaryDirection;
  readonly existingMarkerIds: ReadonlySet<string>;
}

const TITLES: Record<OrchestrationV2ConversationSummaryDirection, string> = {
  from_here: "Summarize from here",
  up_to_here: "Summarize up to here",
};

function failureMessage(cause: Cause.Cause<unknown>, fallback: string) {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

/**
 * Summarize and restore for one thread. The outcome comes from the thread's
 * own state, so a summary started here finishes even if the request outlives
 * this screen's wait, and other devices see the same result.
 */
export function useConversationSummary(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly draftKey: string | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly enabled: boolean;
  readonly threadBusy: boolean;
}): ConversationSummaryFeedControls | null {
  const thread = useThreadProjection({
    environmentId: input.environmentId,
    threadId: input.threadId,
  });
  const projection = thread?.projection ?? null;
  const summarizeThread = useAtomCommand(threadEnvironment.summarize, { reportFailure: false });
  const restoreSummary = useAtomCommand(threadEnvironment.restoreSummary, {
    reportFailure: false,
  });
  const [pending, setPending] = useState<PendingSummary | null>(null);
  const projectionRef = useRef(projection);
  useEffect(() => {
    projectionRef.current = projection;
  }, [projection]);

  const upToHere = useMemo(() => conversationSummaryUpToHereMessageIds(projection), [projection]);
  const fromHere = useMemo(() => conversationSummaryFromHereMessageIds(projection), [projection]);
  const provider = input.providers.find(
    (candidate) => candidate.instanceId === projection?.thread.modelSelection.instanceId,
  );
  const canRewind = provider?.supportsConversationRollback !== false;
  const summarizing =
    projection?.thread.summarize != null && projection.thread.summarize.failure === undefined;

  useEffect(() => {
    if (pending === null || projection === null) return;
    const request = projection.thread.summarize;
    const fail = (message: string) => {
      setPending(null);
      Alert.alert("Could not summarize", message);
    };
    if (request?.requestId === pending.requestId && request.failure !== undefined) {
      fail(request.failure);
      return;
    }
    const rollbackFailure = projection.thread.rollbackFailure;
    if (rollbackFailure?.requestId === `${pending.requestId}:summary-complete`) {
      fail(rollbackFailure.message);
      return;
    }
    const applied = projection.turnItems.some(
      (item) =>
        item.type === "compaction" &&
        item.range?.messageId === pending.messageId &&
        !pending.existingMarkerIds.has(item.id),
    );
    if (!applied) return;
    const message = projection.messages.find((candidate) => candidate.id === pending.messageId);
    const run = projection.runs.find((candidate) => candidate.id === message?.runId);
    if (pending.direction === "from_here" && run?.status !== "rolled_back") return;
    setPending(null);
    if (pending.direction !== "from_here" || message === undefined || input.draftKey === null) {
      return;
    }
    const draftKey = input.draftKey;
    void mergeComposerDraftContent(draftKey, { text: message.text, attachments: [] })
      .then(() => flushComposerDrafts())
      .then(() => {
        if (message.attachments.length > 0) {
          Alert.alert(
            "Attachments not restored",
            "The prompt is back in the composer. Attach its files again before sending.",
          );
        }
      });
  }, [input.draftKey, pending, projection]);

  const start = useCallback(
    (
      messageId: MessageId,
      direction: OrchestrationV2ConversationSummaryDirection,
      instructions: string,
    ) => {
      const current = projectionRef.current;
      if (current === null) return;
      const requestId = CommandId.make(uuidv4());
      setPending({
        requestId,
        messageId,
        direction,
        existingMarkerIds: new Set(
          current.turnItems.filter((item) => item.type === "compaction").map((item) => item.id),
        ),
      });
      void summarizeThread({
        environmentId: input.environmentId,
        input: {
          commandId: requestId,
          threadId: input.threadId,
          messageId,
          direction,
          instructions,
        },
      }).then((result) => {
        if (result._tag === "Success") return;
        setPending(null);
        Alert.alert("Could not summarize", failureMessage(result.cause, "Please try again."));
      });
    },
    [input.environmentId, input.threadId, summarizeThread],
  );

  const summarize = useCallback(
    (messageId: MessageId, direction: OrchestrationV2ConversationSummaryDirection) => {
      const description =
        direction === "from_here"
          ? "This message and everything after it are replaced by a summary in the agent's context. The prompt returns to the composer. Files are not changed."
          : "Everything before this message is replaced by a summary in the agent's context. You can restore the full context later. Files are not changed.";
      if (Platform.OS === "ios") {
        Alert.prompt(
          TITLES[direction],
          `${description}\n\nOptionally, say what the summary should focus on.`,
          [
            { text: "Cancel", style: "cancel" },
            { text: "Summarize", onPress: (value) => start(messageId, direction, value ?? "") },
          ],
          "plain-text",
        );
        return;
      }
      showTextInputDialog({
        title: `${TITLES[direction]}: optional focus`,
        initialValue: "",
        confirmText: "Summarize",
        onConfirm: (value) => start(messageId, direction, value),
      });
    },
    [start],
  );

  const restore = useCallback(
    (turnItemId: TurnItemId) => {
      void restoreSummary({
        environmentId: input.environmentId,
        input: {
          commandId: CommandId.make(uuidv4()),
          threadId: input.threadId,
          turnItemId,
        },
      }).then((result) => {
        if (result._tag === "Success") return;
        Alert.alert(
          "Could not restore the full context",
          failureMessage(result.cause, "Please try again."),
        );
      });
    },
    [input.environmentId, input.threadId, restoreSummary],
  );

  const fromHereUnavailableReason = useCallback(
    (messageId: MessageId) =>
      !canRewind
        ? "This provider cannot rewind its conversation."
        : fromHere.has(messageId)
          ? null
          : "There is no checkpoint before this message.",
    [canRewind, fromHere],
  );
  const upToHereUnavailableReason = useCallback(
    (messageId: MessageId) =>
      upToHere.has(messageId) ? null : "There is nothing before this message to summarize.",
    [upToHere],
  );

  const busy = input.threadBusy || summarizing || pending !== null;
  const activeProviderThreadId = projection?.thread.activeProviderThreadId ?? null;
  const loaded = projection !== null;
  return useMemo(
    () =>
      !input.enabled || !loaded
        ? null
        : {
            summarize,
            restore,
            fromHereUnavailableReason,
            upToHereUnavailableReason,
            activeProviderThreadId,
            busy,
          },
    [
      activeProviderThreadId,
      busy,
      fromHereUnavailableReason,
      input.enabled,
      loaded,
      restore,
      summarize,
      upToHereUnavailableReason,
    ],
  );
}
