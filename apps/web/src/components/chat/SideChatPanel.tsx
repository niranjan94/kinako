import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  resolveLatestForkableRun,
  resolveLatestMergeBackRun,
} from "@t3tools/client-runtime/state/thread-workflows";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon, CornerDownLeftIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import {
  useThreadProjection,
  useThreadShell,
  useThreadVisibleTurnItems,
} from "../../state/entities";
import { sideChatThreadIdAtom } from "../../state/sideChats";
import { environmentServerConfigsAtom } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { threadEnvironment } from "../../state/threads";
import { useRightPanelStore } from "../../rightPanelStore";
import { buildThreadRouteParams } from "../../threadRoutes";
import { newMessageId, newThreadId } from "../../lib/utils";
import { threadContextRecord, threadContextReference } from "../../lib/composerContextRecords";
import {
  ensureInlineContextReferences,
  stripInlineContextReferences,
} from "../../lib/composerContextReferences";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { getComposerPromptLengthValidationMessage } from "./composerSubmission";
import { sideChatMessages } from "./sideChat.logic";

export default function SideChatPanel({
  parentRef,
  workspaceRoot,
}: {
  parentRef: ScopedThreadRef;
  workspaceRoot: string | undefined;
}) {
  const parent = useThreadProjection(parentRef)?.projection ?? null;
  const savedId = useAtomValue(sideChatThreadIdAtom(scopedThreadKey(parentRef)));
  const [createdId, setCreatedId] = useState<ThreadId | null>(null);
  const sideId = createdId ?? savedId;
  const sideRef = sideId === null ? null : scopeThreadRef(parentRef.environmentId, sideId);
  const side = useThreadProjection(sideRef)?.projection ?? null;
  const shell = useThreadShell(sideRef);
  const items = useThreadVisibleTurnItems(sideRef);
  const messages = sideChatMessages(items, sideId);
  const lastMessage = messages.at(-1);
  const draftTarget = DraftId.make(`side-chat:${scopedThreadKey(parentRef)}`);
  const draft = useComposerDraftStore((store) => store.getComposerDraft(draftTarget)?.prompt ?? "");
  const setPrompt = useComposerDraftStore((store) => store.setPrompt);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<"send" | "promote" | "join" | "stop" | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const navigate = useNavigate();
  const hasPermission = useEnvironmentScope(parentRef.environmentId, AuthOrchestrationOperateScope);
  const supportsSideChats =
    useAtomValue(environmentServerConfigsAtom).get(parentRef.environmentId)?.environment
      .capabilities.sideChats === true;
  const canOperate = hasPermission && supportsSideChats;
  const fork = useOrchestrationCommand(threadEnvironment.forkFromRun, { reportFailure: false });
  const send = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const update = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const merge = useOrchestrationCommand(threadEnvironment.mergeBack, { reportFailure: false });
  const interrupt = useOrchestrationCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const sourceRun = parent === null ? null : resolveLatestForkableRun(parent);
  const mergeRun = side === null ? null : resolveLatestMergeBackRun(side);
  const running =
    side?.runs.some((run) =>
      ["queued", "preparing", "starting", "running", "waiting"].includes(run.status),
    ) === true;
  const needsInput = shell?.hasPendingApprovals || shell?.hasPendingUserInput;
  const alreadyJoined =
    mergeRun !== null &&
    parent?.contextTransfers.some(
      (transfer) =>
        transfer.type === "merge_back" &&
        transfer.sourceThreadId === sideId &&
        transfer.targetThreadId === parentRef.threadId &&
        transfer.status !== "failed" &&
        transfer.status !== "superseded" &&
        transfer.sourcePoint.runId === mergeRun.id,
    );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (lastMessage === undefined) return;
    const container = scrollRef.current;
    if (container && following.current) container.scrollTop = container.scrollHeight;
  }, [lastMessage]);

  const perform = (kind: NonNullable<typeof action>, work: () => Promise<void>) => {
    if (inFlight.current || !canOperate) return;
    inFlight.current = true;
    setAction(kind);
    setError(null);
    void work()
      .catch((cause: unknown) => {
        setError(
          cause instanceof Error ? cause.message : "The side chat could not complete this action.",
        );
      })
      .finally(() => {
        inFlight.current = false;
        setAction(null);
      });
  };

  const submit = () =>
    perform("send", async () => {
      if (!parent || !draft.trim() || running) return;
      const context = threadContextRecord(parentRef, parent.thread.title);
      const text = ensureInlineContextReferences(draft.trim(), [threadContextReference(context)]);
      const validation = getComposerPromptLengthValidationMessage(text);
      if (validation) throw new Error(validation);
      let targetId = sideId;
      if (targetId === null) {
        if (!sourceRun)
          throw new Error("Finish one turn in the conversation before starting a side chat.");
        targetId = newThreadId();
        const result = await fork({
          environmentId: parentRef.environmentId,
          input: {
            sourceThreadId: parentRef.threadId,
            targetThreadId: targetId,
            runId: sourceRun.id,
            title: draft.trim().replace(/\s+/g, " ").slice(0, 120),
            isSideChat: true,
          },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        setCreatedId(targetId);
      }
      const result = await send({
        environmentId: parentRef.environmentId,
        input: {
          threadId: targetId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text,
            attachments: [],
            context: { version: 1, records: [context] },
          },
          modelSelection: side?.thread.modelSelection ?? parent.thread.modelSelection,
          runtimeMode: side?.thread.runtimeMode ?? parent.thread.runtimeMode,
          interactionMode: side?.thread.interactionMode ?? parent.thread.interactionMode,
          dispatchMode: "start",
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      if (useComposerDraftStore.getState().getComposerDraft(draftTarget)?.prompt === draft)
        setPrompt(draftTarget, "");
    });

  const promote = () =>
    perform("promote", async () => {
      if (sideId === null) return;
      const result = await update({
        environmentId: parentRef.environmentId,
        input: { threadId: sideId, isSideChat: false },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      const pendingDraft =
        useComposerDraftStore.getState().getComposerDraft(draftTarget)?.prompt ?? "";
      if (pendingDraft.trim()) {
        const target = scopeThreadRef(parentRef.environmentId, sideId);
        const existing = useComposerDraftStore.getState().getComposerDraft(target)?.prompt ?? "";
        setPrompt(target, existing.trim() ? `${existing}\n\n${pendingDraft}` : pendingDraft);
        setPrompt(draftTarget, "");
      }
      useRightPanelStore.getState().closeSurface(parentRef, "side-chat");
      if (mounted.current)
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(parentRef.environmentId, sideId)),
        });
    });

  const join = () =>
    perform("join", async () => {
      if (sideId === null || mergeRun === null || alreadyJoined) return;
      const result = await merge({
        environmentId: parentRef.environmentId,
        input: {
          sourceThreadId: sideId,
          targetThreadId: parentRef.threadId,
          runId: mergeRun.id,
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      useRightPanelStore.getState().closeSurface(parentRef, "side-chat");
    });

  const stop = () =>
    perform("stop", async () => {
      if (sideId === null) return;
      const result = await interrupt({
        environmentId: parentRef.environmentId,
        input: { threadId: sideId },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    });

  return (
    <section aria-label="Side chat" className="flex h-full min-h-0 flex-col bg-background">
      <div className="space-y-3 border-b border-border/60 px-4 py-4">
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">About this conversation</p>
          <p className="truncate text-sm font-medium">{parent?.thread.title}</p>
        </div>
        {sideId ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={action !== null || !canOperate}
              onClick={promote}
            >
              <ArrowUpRightIcon /> Make a thread
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={action !== null || !canOperate || mergeRun === null || alreadyJoined}
              onClick={join}
            >
              <CornerDownLeftIcon /> {alreadyJoined ? "Joined" : "Join conversation"}
            </Button>
          </div>
        ) : null}
      </div>
      <div
        ref={scrollRef}
        onScroll={(event) => {
          const container = event.currentTarget;
          following.current =
            container.scrollHeight - container.clientHeight - container.scrollTop < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-5"
        aria-busy={running}
      >
        {!supportsSideChats ? (
          <p className="text-xs text-muted-foreground">
            Update this environment to use side chats.
          </p>
        ) : null}
        {messages.length === 0 ? (
          <div className="space-y-2 py-6 text-sm text-muted-foreground">
            <p>Ask a question without interrupting the conversation.</p>
            <p className="text-xs leading-relaxed">
              Starts with the last finished turn. The current conversation is attached for
              reference.
            </p>
            {!sourceRun ? (
              <p className="text-xs">Available after the first turn finishes.</p>
            ) : null}
          </div>
        ) : (
          <div className="space-y-5">
            {messages.map((message) => (
              <article key={message.id} className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">
                  {message.type === "user_message" ? "You" : "Assistant"}
                </p>
                <ChatMarkdown
                  text={stripInlineContextReferences(message.text)}
                  cwd={workspaceRoot}
                  threadRef={sideRef ?? undefined}
                  pullRequestPanelRef={parentRef}
                  environmentId={parentRef.environmentId}
                  isStreaming={message.type === "assistant_message" && message.streaming}
                />
              </article>
            ))}
          </div>
        )}
        {running ? (
          <p role="status" className="mt-4 text-xs text-muted-foreground">
            {needsInput ? "Needs your input. Make this a thread to respond." : "Thinking…"}
          </p>
        ) : null}
        {error || shell?.runtime?.lastError ? (
          <p role="alert" className="mt-4 text-xs text-destructive">
            {error ?? shell?.runtime?.lastError}
          </p>
        ) : null}
      </div>
      <form
        className="space-y-3 border-t border-border/60 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Textarea
          aria-label="Side question"
          placeholder="Ask a side question…"
          value={draft}
          disabled={!canOperate}
          onChange={(event) => setPrompt(draftTarget, event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {side?.thread.modelSelection.model ?? parent?.thread.modelSelection.model}
          </span>
          {running ? (
            <Button
              variant="outline"
              size="sm"
              disabled={action !== null || !canOperate}
              onClick={stop}
            >
              Stop side chat
            </Button>
          ) : (
            <Button
              type="submit"
              size="sm"
              disabled={
                !canOperate || action !== null || !draft.trim() || (sideId === null && !sourceRun)
              }
            >
              {action === "send" ? "Sending…" : "Ask"}
            </Button>
          )}
        </div>
      </form>
    </section>
  );
}
