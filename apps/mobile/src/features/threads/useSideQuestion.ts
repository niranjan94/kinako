import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { findLatestSideChat } from "@t3tools/client-runtime/state/side-chats";
import {
  resolveLatestForkableRun,
  resolveLatestMergeBackRun,
} from "@t3tools/client-runtime/state/thread-workflows";
import {
  MessageId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { threadComposerContext } from "../../lib/composerContext";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  environmentThreadDetails,
  environmentThreadShells,
  threadEnvironment,
} from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import { withParentThreadReference } from "./sideQuestionCommand";

export const latestSideChatAtom = Atom.family((parentKey: string) =>
  Atom.make((get) => {
    const parent = parseScopedThreadKey(parentKey);
    return parent === null
      ? null
      : findLatestSideChat(get(environmentThreadShells.threadShellsAtom), parent);
  }),
);

function unwrap<A, E>(result: AtomCommandResult<A, E>): void {
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
}

function readOpenSideChat(parentRef: ScopedThreadRef) {
  const latest = appAtomRegistry.get(latestSideChatAtom(scopedThreadKey(parentRef)));
  return latest !== null && latest.settledOverride !== "settled" ? latest : null;
}

const COMMAND_OPTIONS = { reportFailure: false } as const;

export function useSideQuestionActions() {
  const selectDetail = useSelectWorkspaceDetail();
  const ask = useAtomCommand(threadEnvironment.askSideQuestion, COMMAND_OPTIONS);
  const settle = useAtomCommand(threadEnvironment.settle, COMMAND_OPTIONS);
  const unsettle = useAtomCommand(threadEnvironment.unsettle, COMMAND_OPTIONS);
  const update = useAtomCommand(threadEnvironment.updateMetadata, COMMAND_OPTIONS);
  const merge = useAtomCommand(threadEnvironment.mergeBack, COMMAND_OPTIONS);
  const interrupt = useAtomCommand(threadEnvironment.interruptTurn, COMMAND_OPTIONS);

  return {
    /** Follows up in the open side chat, or forks a new one from the last finished turn. */
    ask: async (parentRef: ScopedThreadRef, question: string) => {
      const parent: OrchestrationV2ThreadProjection | null =
        appAtomRegistry.get(environmentThreadDetails.threadAtom(parentRef))?.projection ?? null;
      if (parent === null) throw new Error("Wait for the thread to load, then try again.");
      const context = threadComposerContext(parentRef, parent.thread.title);
      const text = withParentThreadReference(question, context);
      if (text.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS)
        throw new Error("The side question is too long. Shorten it and try again.");
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
            sideThreadId: open?.id ?? ThreadId.make(uuidv4()),
            creationSource: "mobile",
            ...(sourceRun === null
              ? {}
              : {
                  fork: {
                    runId: sourceRun.id,
                    title: question.replace(/\s+/g, " ").slice(0, 120),
                  },
                }),
            message: {
              messageId: MessageId.make(uuidv4()),
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
      selectDetail({
        name: "Thread",
        params: {
          environmentId: String(sideRef.environmentId),
          threadId: String(sideRef.threadId),
        },
      });
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
            creationSource: "mobile",
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
