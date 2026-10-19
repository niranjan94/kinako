import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type {
  OrchestrationV2ProjectedTurnItem,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";

type SideChatThread = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "isSideChat" | "archivedAt" | "deletedAt" | "lineage" | "createdAt"
>;

export function findSideChatThreadId(
  threads: ReadonlyArray<SideChatThread>,
  parent: ScopedThreadRef,
): ThreadId | null {
  let latest: SideChatThread | undefined;
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
  return latest?.id ?? null;
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
