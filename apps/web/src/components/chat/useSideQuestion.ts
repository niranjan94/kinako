import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  resolveLatestForkableRun,
  resolveLatestMergeBackRun,
} from "@t3tools/client-runtime/state/thread-workflows";
import type { OrchestrationV2ThreadProjection, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { threadContextRecord, threadContextReference } from "../../lib/composerContextRecords";
import { ensureInlineContextReferences } from "../../lib/composerContextReferences";
import { newMessageId, newThreadId } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { latestSideChatAtom } from "../../state/sideChats";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { getComposerPromptLengthValidationMessage } from "./composerSubmission";

function unwrap<A, E>(result: AtomCommandResult<A, E>): void {
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
}

function readOpenSideChat(parentRef: ScopedThreadRef) {
  const latest = appAtomRegistry.get(latestSideChatAtom(scopedThreadKey(parentRef)));
  return latest !== null && latest.settledOverride !== "settled" ? latest : null;
}

export function useSideQuestionActions() {
  const navigate = useNavigate();
  const ask = useOrchestrationCommand(threadEnvironment.askSideQuestion, { reportFailure: false });
  const settle = useOrchestrationCommand(threadEnvironment.settle, { reportFailure: false });
  const unsettle = useOrchestrationCommand(threadEnvironment.unsettle, { reportFailure: false });
  const update = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const merge = useOrchestrationCommand(threadEnvironment.mergeBack, { reportFailure: false });
  const interrupt = useOrchestrationCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });

  return {
    /** Follows up in the open side chat, or forks a new one from the last finished turn. */
    ask: async (
      parentRef: ScopedThreadRef,
      parent: OrchestrationV2ThreadProjection,
      question: string,
    ) => {
      const context = threadContextRecord(parentRef, parent.thread.title);
      const text = ensureInlineContextReferences(question, [threadContextReference(context)]);
      const validation = getComposerPromptLengthValidationMessage(text);
      if (validation) throw new Error(validation);
      const open = readOpenSideChat(parentRef);
      if (open !== null && threadRuntimeIsActive(open.runtime))
        throw new Error("Wait for the side question to finish, or stop it.");
      const sourceRun = open === null ? resolveLatestForkableRun(parent) : null;
      if (open === null && sourceRun === null)
        throw new Error("Finish a turn before asking a side question.");
      unwrap(
        await ask({
          environmentId: parentRef.environmentId,
          input: {
            parentThreadId: parentRef.threadId,
            sideThreadId: open?.id ?? newThreadId(),
            ...(sourceRun === null
              ? {}
              : {
                  fork: {
                    runId: sourceRun.id,
                    title: question.replace(/\s+/g, " ").slice(0, 120),
                  },
                }),
            message: {
              messageId: newMessageId(),
              text,
              context: { version: 1, records: [context] },
            },
          },
        }),
      );
    },
    /** Reopens the most recent dismissed side chat; false when there is none. */
    reopen: async (parentRef: ScopedThreadRef) => {
      const latest = appAtomRegistry.get(latestSideChatAtom(scopedThreadKey(parentRef)));
      if (latest === null) return false;
      if (latest.settledOverride === "settled")
        unwrap(
          await unsettle({
            environmentId: parentRef.environmentId,
            input: { threadId: latest.id, reason: "user" },
          }),
        );
      return true;
    },
    dismiss: async (sideRef: ScopedThreadRef) =>
      unwrap(await settle({ environmentId: sideRef.environmentId, input: sideRef })),
    stop: async (sideRef: ScopedThreadRef) =>
      unwrap(await interrupt({ environmentId: sideRef.environmentId, input: sideRef })),
    promote: async (sideRef: ScopedThreadRef) => {
      unwrap(
        await update({
          environmentId: sideRef.environmentId,
          input: { threadId: sideRef.threadId, isSideChat: false },
        }),
      );
      await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(sideRef) });
    },
    join: async (parentRef: ScopedThreadRef, side: OrchestrationV2ThreadProjection) => {
      const run = resolveLatestMergeBackRun(side);
      if (run === null) throw new Error("Wait for an answer before adding it to the conversation.");
      unwrap(
        await merge({
          environmentId: parentRef.environmentId,
          input: {
            sourceThreadId: side.thread.id,
            targetThreadId: parentRef.threadId,
            runId: run.id,
          },
        }),
      );
      unwrap(
        await settle({
          environmentId: parentRef.environmentId,
          input: { threadId: side.thread.id },
        }),
      );
    },
  };
}
