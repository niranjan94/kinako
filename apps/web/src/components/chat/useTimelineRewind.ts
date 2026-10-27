import type { EnvironmentThreadShell, ThreadStructure } from "@t3tools/client-runtime/state/shell";
import type { ComposerThreadTarget } from "../../composerDraftStore";
import type { ComposerHandleRef } from "../../composerHandleContext";
import type { SessionPhase } from "../../types";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  type EnvironmentId,
  type MessageId,
  type OrchestrationV2ConversationSummaryDirection,
  type ScopedThreadRef,
  type ThreadId,
  type TurnItemId,
  type RunId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  conversationSummaryFromHereMessageIds,
  conversationSummaryUpToHereMessageIds,
} from "@t3tools/client-runtime/state/conversationSummary";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { readLocalApi } from "../../localApi";
import { findRevertCheckpoint } from "../../session-logic";
import { type ChatMessage } from "../../types";
import { newThreadId, randomUUID } from "~/lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useComposerDraftStore } from "../../composerDraftStore";
import { threadEnvironment } from "../../state/threads";
import { waitForThreadShell } from "../../state/entities";
import { openRevertConfirm } from "./ChatOverlayHosts";
import { assetEnvironment } from "../../state/assets";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { rewindToMessage } from "./chatViewSend";
import {
  makeThreadErrorSetter,
  waitForRevertedMessage,
  waitForThreadSummary,
} from "../ChatView.logic";
import type { ConversationSummaryTimelineControls } from "./ConversationSummary";
interface TimelineRewindInput {
  readonly environmentId: EnvironmentId;
  readonly routeThreadRef: ScopedThreadRef;
  readonly routeThreadKey: string;
  readonly currentRouteThreadKeyRef: { readonly current: string | null };
  readonly serverProjection: ThreadStructure | null;
  readonly activeThread: EnvironmentThreadShell | undefined;
  readonly timelineMessages: ReadonlyArray<ChatMessage>;
  readonly canOperateThread: boolean;
  readonly phase: SessionPhase;
  readonly isConnecting: boolean;
  readonly isSendBusy: boolean;
  readonly isRevertingCheckpoint: boolean;
  readonly supportsConversationRollback: boolean;
  /** Shown with rollback confirmations when checkpoints cannot restore every directory. */
  readonly restoreNote: string | null;
  readonly activeEnvironmentUnavailable: boolean;
  readonly activeEnvironmentUnavailableLabel: string | null;
  readonly promptRef: { current: string };
  readonly composerRef: ComposerHandleRef;
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly setThreadError: ReturnType<typeof makeThreadErrorSetter>;
}

/**
 * Going back in a thread's timeline: reverting to an earlier turn (restoring that message into
 * the composer), rolling back a provider checkpoint, and forking a new thread from a run.
 */
export function useTimelineRewind(input: TimelineRewindInput) {
  const {
    environmentId,
    routeThreadRef,
    routeThreadKey,
    currentRouteThreadKeyRef,
    serverProjection,
    activeThread,
    timelineMessages,
    canOperateThread,
    phase,
    isConnecting,
    isSendBusy,
    isRevertingCheckpoint,
    supportsConversationRollback,
    restoreNote,
    activeEnvironmentUnavailable,
    activeEnvironmentUnavailableLabel,
    promptRef,
    composerRef,
    composerDraftTarget,
    setThreadError,
  } = input;
  const navigate = useNavigate();
  const createAttachmentAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });

  const revertThreadCheckpoint = useOrchestrationCommand(threadEnvironment.revertCheckpoint, {
    reportFailure: false,
  });
  const summarizeThread = useOrchestrationCommand(threadEnvironment.summarize, {
    reportFailure: false,
  });
  const restoreThreadSummary = useOrchestrationCommand(threadEnvironment.restoreSummary, {
    reportFailure: false,
  });
  const forkThreadFromRun = useAtomCommand(threadEnvironment.forkFromRun, {
    reportFailure: false,
  });

  const readRewindableMessage = (messageId: MessageId) => {
    const message = timelineMessages.find((message) => message.id === messageId);
    return message?.role === "user" ? message : undefined;
  };

  /**
   * Runs `rewind`, then returns the message's prompt and attachments to the
   * composer. Edit and summarize from here share it.
   */
  const rewindMessageIntoComposer = async (
    message: ChatMessage,
    threadId: ThreadId,
    rewind: () => Promise<void>,
  ) => {
    useComposerDraftStore.setState((store) => ({
      rewindingThreadKeys: new Set(store.rewindingThreadKeys).add(routeThreadKey),
    }));
    setThreadError(threadId, null);
    const result = await rewindToMessage({
      message,
      environmentId,
      draftTarget: composerDraftTarget,
      composerHasPendingAttachments: composerRef.current?.hasPendingAttachments() === true,
      createAssetUrl: createAttachmentAssetUrl,
      rewind,
    });
    useComposerDraftStore.setState((store) => {
      const remaining = new Set(store.rewindingThreadKeys);
      remaining.delete(routeThreadKey);
      return { rewindingThreadKeys: remaining };
    });
    if (result.error !== null) {
      setThreadError(threadId, result.error);
      return;
    }
    if (currentRouteThreadKeyRef.current === routeThreadKey) {
      const nextPrompt = result.prompt;
      promptRef.current = nextPrompt;
      composerRef.current?.resetCursorState({ prompt: nextPrompt, cursor: nextPrompt.length });
      requestAnimationFrame(() => {
        if (currentRouteThreadKeyRef.current === routeThreadKey) composerRef.current?.focusAtEnd();
      });
    }
  };

  /** Why the thread cannot rewind or summarize now, or null when it can. */
  const conversationChangeBlocker = (action: string) => {
    if (activeEnvironmentUnavailable && activeEnvironmentUnavailableLabel) {
      return `Reconnect ${activeEnvironmentUnavailableLabel} before ${action}.`;
    }
    if (phase === "running" || isSendBusy || isConnecting) {
      return `Interrupt the current turn before ${action}.`;
    }
    return null;
  };

  const onRevertToTurnCount = async (
    turnCount: number,
    messageId: MessageId,
    restoreFiles?: boolean,
  ) => {
    const localApi = readLocalApi();
    if (
      !localApi ||
      !activeThread ||
      isRevertingCheckpoint ||
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
    )
      return;
    const message = readRewindableMessage(messageId);
    if (!message) return;

    if (!supportsConversationRollback) {
      setThreadError(
        activeThread.id,
        "This provider does not support reverting conversation history. Start a new thread instead.",
      );
      return;
    }
    const blocker = conversationChangeBlocker("reverting checkpoints");
    if (blocker !== null) {
      setThreadError(activeThread.id, blocker);
      return;
    }
    if (restoreFiles === undefined) {
      openRevertConfirm(routeThreadKey, { turnCount, messageId });
      return;
    }

    const threadId = activeThread.id;
    const commandId = CommandId.make(randomUUID());
    // Keep the live checkpoint identity when command context refetches a bounded window.
    const checkpoint = findRevertCheckpoint(serverProjection?.checkpoints ?? [], turnCount);
    await rewindMessageIntoComposer(message, threadId, () =>
      waitForRevertedMessage(routeThreadRef, turnCount, commandId, async () => {
        const result = await revertThreadCheckpoint({
          environmentId,
          input: {
            commandId,
            threadId,
            turnCount,
            restoreFiles,
            ...(checkpoint === undefined
              ? {}
              : { checkpointId: checkpoint.id, scopeId: checkpoint.scopeId }),
          },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      }),
    );
  };
  const onRevertToTurnCountStable = useStableCallback(onRevertToTurnCount);
  const onConfirmRevert = (turnCount: number, messageId: MessageId, restoreFiles: boolean) => {
    void onRevertToTurnCount(turnCount, messageId, restoreFiles);
  };
  const onConfirmRevertStable = useStableCallback(onConfirmRevert);

  const [pendingSummary, setPendingSummary] = useState<{
    messageId: MessageId;
    direction: OrchestrationV2ConversationSummaryDirection;
    routeThreadKey: string;
  } | null>(null);
  if (pendingSummary && pendingSummary.routeThreadKey !== routeThreadKey) {
    setPendingSummary(null);
  }
  const isSummarizing =
    serverProjection?.thread.summarize != null &&
    serverProjection.thread.summarize.failure === undefined;

  const onSummarizeMessage = (
    messageId: MessageId,
    direction: OrchestrationV2ConversationSummaryDirection,
  ) => {
    if (
      !activeThread ||
      isRevertingCheckpoint ||
      isSummarizing ||
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      !readRewindableMessage(messageId)
    )
      return;
    const blocker = conversationChangeBlocker("summarizing");
    if (blocker !== null) {
      setThreadError(activeThread.id, blocker);
      return;
    }
    setPendingSummary({ messageId, direction, routeThreadKey });
  };
  const onSummarizeMessageStable = useStableCallback(onSummarizeMessage);

  const confirmSummary = async (instructions: string) => {
    const pending = pendingSummary;
    setPendingSummary(null);
    if (!pending || pending.routeThreadKey !== routeThreadKey || !activeThread) return;
    const message = readRewindableMessage(pending.messageId);
    if (!message) return;
    const threadId = activeThread.id;
    const commandId = CommandId.make(randomUUID());
    const summarize = () =>
      waitForThreadSummary({
        threadRef: routeThreadRef,
        messageId: pending.messageId,
        direction: pending.direction,
        requestId: commandId,
        summarize: async () => {
          const result = await summarizeThread({
            environmentId,
            input: {
              commandId,
              threadId,
              messageId: pending.messageId,
              direction: pending.direction,
              instructions,
            },
          });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        },
      });
    if (pending.direction === "from_here") {
      await rewindMessageIntoComposer(message, threadId, summarize);
      return;
    }
    setThreadError(threadId, null);
    await summarize().catch((error: unknown) => {
      setThreadError(
        threadId,
        error instanceof Error ? error.message : "Failed to summarize the conversation.",
      );
    });
  };
  const confirmSummaryStable = useStableCallback((instructions: string) => {
    void confirmSummary(instructions);
  });
  const cancelSummaryStable = useStableCallback(() => setPendingSummary(null));

  const onRestoreSummary = async (turnItemId: TurnItemId) => {
    if (!activeThread || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope))
      return;
    const blocker = conversationChangeBlocker("restoring the full context");
    if (blocker !== null) {
      setThreadError(activeThread.id, blocker);
      return;
    }
    setThreadError(activeThread.id, null);
    const result = await restoreThreadSummary({
      environmentId,
      input: { commandId: CommandId.make(randomUUID()), threadId: activeThread.id, turnItemId },
    });
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setThreadError(
        activeThread.id,
        failure instanceof Error ? failure.message : "Failed to restore the full context.",
      );
    }
  };
  const onRestoreTimelineSummaryStable = useStableCallback((turnItemId: TurnItemId) => {
    void onRestoreSummary(turnItemId);
  });
  const summaryUpToHereMessageIds = (() =>
    conversationSummaryUpToHereMessageIds(serverProjection))();
  const summaryFromHereMessageIds = (() =>
    conversationSummaryFromHereMessageIds(serverProjection))();
  const activeProviderThreadId = serverProjection?.thread.activeProviderThreadId ?? null;
  const conversationSummaryControls = ((): ConversationSummaryTimelineControls | null =>
    !canOperateThread
      ? null
      : {
          onSummarize: onSummarizeMessageStable,
          onRestore: onRestoreTimelineSummaryStable,
          upToHereMessageIds: summaryUpToHereMessageIds,
          fromHereMessageIds: summaryFromHereMessageIds,
          supportsConversationRollback,
          activeProviderThreadId,
        })();

  const onRollbackCheckpoint = async (input: {
    readonly checkpointId: string;
    readonly scopeId: string;
  }) => {
    if (!activeThread || isRevertingCheckpoint) return;
    const blocker = conversationChangeBlocker("reverting checkpoints");
    if (blocker !== null) {
      setThreadError(activeThread.id, blocker);
      return;
    }
    const localApi = readLocalApi();
    const confirmed =
      localApi == null
        ? window.confirm(
            ["Roll back this thread to the selected checkpoint?", restoreNote]
              .filter(Boolean)
              .join("\n"),
          )
        : await localApi.dialogs.confirm(
            [
              "Roll back this thread to the selected checkpoint?",
              "This action cannot be undone.",
              restoreNote,
            ]
              .filter(Boolean)
              .join("\n"),
          );
    if (!confirmed) return;

    useComposerDraftStore.setState((store) => ({
      rewindingThreadKeys: new Set(store.rewindingThreadKeys).add(routeThreadKey),
    }));
    setThreadError(activeThread.id, null);
    const result = await revertThreadCheckpoint({
      environmentId,
      input: {
        threadId: activeThread.id,
        checkpointId: input.checkpointId,
        scopeId: input.scopeId,
      },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setThreadError(
        activeThread.id,
        error instanceof Error ? error.message : "Failed to revert thread state.",
      );
    }
    useComposerDraftStore.setState((store) => {
      const remaining = new Set(store.rewindingThreadKeys);
      remaining.delete(routeThreadKey);
      return { rewindingThreadKeys: remaining };
    });
  };

  const onForkFromRun = async (input: {
    readonly sourceThreadId: ThreadId;
    readonly runId: RunId;
  }) => {
    if (!activeThread || activeEnvironmentUnavailable) return;
    const targetThreadId = newThreadId();
    const targetThreadRef = scopeThreadRef(environmentId, targetThreadId);
    const result = await forkThreadFromRun({
      environmentId,
      input: {
        sourceThreadId: input.sourceThreadId,
        targetThreadId,
        runId: input.runId,
        title: `${activeThread.title} fork`,
      },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          activeThread.id,
          error instanceof Error ? error.message : "Failed to fork this response.",
        );
      }
      return;
    }
    const targetThreadReady = await waitForThreadShell(targetThreadRef);
    if (!targetThreadReady) {
      setThreadError(
        activeThread.id,
        "The fork was created, but its thread data did not reach this client. Reconnect and try opening it from the sidebar.",
      );
      return;
    }
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(targetThreadRef),
    });
  };
  const onForkFromRunStable = useStableCallback(onForkFromRun);
  const onTimelineRollbackCheckpoint = (input: {
    readonly checkpointId: string;
    readonly scopeId: string;
  }) => {
    void onRollbackCheckpoint(input);
  };
  const onTimelineRollbackCheckpointStable = useStableCallback(onTimelineRollbackCheckpoint);
  const onRevertTimelineTurn = (targetTurnCount: number, messageId: MessageId) => {
    void onRevertToTurnCountStable(targetTurnCount, messageId);
  };
  const onRevertTimelineTurnStable = useStableCallback(onRevertTimelineTurn);
  return {
    onConfirmRevertStable,
    onForkFromRunStable,
    onRevertTimelineTurnStable,
    onTimelineRollbackCheckpointStable,
    conversationSummaryControls,
    isSummarizing,
    pendingSummaryDirection: pendingSummary?.direction ?? null,
    confirmSummaryStable,
    cancelSummaryStable,
  };
}
