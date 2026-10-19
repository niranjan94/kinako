import type { EnvironmentThreadShell } from "./shell.ts";
import type {
  OrchestrationV2ProjectedTurnItem,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";

type SideChatThread = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "isSideChat" | "archivedAt" | "deletedAt" | "lineage" | "createdAt"
>;

export type SideQuestionSubmissionTarget =
  | "provider-turn"
  | "pending-user-input"
  | "queued-message";

/** The question after `/btw`, `""` for a bare `/btw`, or null when the draft is not a side question. */
export function parseBtwComposerQuestion(
  text: string,
  submissionTarget: SideQuestionSubmissionTarget = "provider-turn",
): string | null {
  if (submissionTarget !== "provider-turn") return null;
  const match = /^\/btw(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match === null ? null : (match[1]?.trim() ?? "");
}

export function findLatestSideChat<Thread extends SideChatThread>(
  threads: ReadonlyArray<Thread>,
  parent: ScopedThreadRef,
): Thread | null {
  let latest: Thread | undefined;
  for (const thread of threads) {
    if (
      thread.environmentId !== parent.environmentId ||
      !thread.isSideChat ||
      thread.archivedAt !== null ||
      thread.deletedAt !== null ||
      thread.lineage.parentThreadId !== parent.threadId
    )
      continue;
    if (!latest || thread.createdAt > latest.createdAt) latest = thread;
  }
  return latest ?? null;
}

export function sideChatMessages(
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  threadId: ThreadId | null,
) {
  return items.flatMap(({ item, sourceThreadId }) =>
    sourceThreadId === threadId &&
    (item.type === "user_message" || item.type === "assistant_message")
      ? [item]
      : [],
  );
}
