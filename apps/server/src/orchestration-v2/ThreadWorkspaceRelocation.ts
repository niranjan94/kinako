import type {
  CommandId,
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { relocatePathUnderRoot } from "@t3tools/shared/path";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

export interface ThreadWorkspaceRelocationPlan {
  readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  readonly effects: ReadonlyArray<PendingOrchestrationEffectV2>;
}

/**
 * Rebases a thread's stored paths from its project's old root onto the new
 * one and detaches sessions still running under the old root. Paths outside
 * the old root are left alone, so planning again after a partial relocation
 * only covers what is still stale.
 */
export const planThreadWorkspaceRelocation = Effect.fn(
  "ThreadWorkspaceRelocation.planThreadWorkspaceRelocation",
)(function* (input: {
  readonly commandId: CommandId;
  readonly projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "checkpointScopes" | "providerSessions"
  >;
  readonly fromRoot: string;
  readonly toRoot: string;
  readonly caseInsensitive: boolean;
  readonly now: DateTime.Utc;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
}): Effect.fn.Return<ThreadWorkspaceRelocationPlan, IdAllocator.IdAllocatorV2Error> {
  const { commandId, projection, now, idAllocator } = input;
  const { thread } = projection;
  const options = { caseInsensitive: input.caseInsensitive };
  const isUnder = (path: string, root: string) =>
    relocatePathUnderRoot(path, root, root, options) !== null;
  // When the new root sits inside the old one, an already rebased path is
  // still under the old root; rebasing it again would nest it twice.
  const toRootNestedInFromRoot =
    isUnder(input.toRoot, input.fromRoot) && !isUnder(input.fromRoot, input.toRoot);
  const relocate = (path: string) =>
    toRootNestedInFromRoot && isUnder(path, input.toRoot)
      ? null
      : relocatePathUnderRoot(path, input.fromRoot, input.toRoot, options);
  const events: Array<OrchestrationV2DomainEvent> = [];
  const effects: Array<PendingOrchestrationEffectV2> = [];
  const emitEvent = Effect.fn("ThreadWorkspaceRelocation.emitEvent")(function* <
    Event extends OrchestrationV2DomainEvent,
  >(event: Omit<Event, "id">) {
    const id = yield* idAllocator.allocate.event({ threadId: event.threadId, commandId });
    events.push({ ...event, id } as Event);
  });

  const worktreePath = thread.worktreePath === null ? null : relocate(thread.worktreePath);
  const associatedWorktreePath =
    thread.associatedWorktreePath == null ? null : relocate(thread.associatedWorktreePath);
  if (worktreePath !== null || associatedWorktreePath !== null) {
    yield* emitEvent({
      type: "thread.metadata-updated",
      threadId: thread.id,
      providerInstanceId: thread.providerInstanceId,
      occurredAt: now,
      payload: {
        ...thread,
        ...(worktreePath === null ? {} : { worktreePath }),
        ...(associatedWorktreePath === null ? {} : { associatedWorktreePath }),
        updatedAt: now,
      },
    });
  }

  for (const scope of projection.checkpointScopes) {
    const cwd = relocate(scope.cwd);
    if (cwd === null) continue;
    yield* emitEvent({
      type: "checkpoint-scope.created",
      threadId: thread.id,
      ...(scope.runId === null ? {} : { runId: scope.runId }),
      nodeId: scope.nodeId,
      providerInstanceId: thread.providerInstanceId,
      occurredAt: now,
      payload: { ...scope, cwd },
    });
  }

  // A plain detach keeps the native thread ref, so the next turn opens a
  // session at the new root and resumes the same conversation.
  const reason = "Project folder moved.";
  for (const session of projection.providerSessions) {
    if (session.status === "stopped" || session.status === "error") continue;
    if (relocate(session.cwd) === null) continue;
    yield* emitEvent({
      type: "provider-session.detached",
      threadId: thread.id,
      driver: session.driver,
      providerInstanceId: session.providerInstanceId,
      occurredAt: now,
      payload: { providerSessionId: session.id, detachedAt: now, reason },
    });
    effects.push({
      id: `effect:${commandId}:provider-session.detach:${session.id}`,
      commandId,
      threadId: thread.id,
      request: { type: "provider-session.detach", providerSessionId: session.id, detail: reason },
    });
  }

  return { events, effects };
});
