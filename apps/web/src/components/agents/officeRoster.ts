import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  officeAgentState,
  officeThreadKey,
  type OfficeAgent,
  type OfficeSubagent,
} from "./officeBridge";

export function buildOfficeRoster(
  threads: readonly EnvironmentThreadShell[],
  options: {
    now: string;
    connected: (thread: EnvironmentThreadShell) => boolean;
    projectName: (thread: EnvironmentThreadShell) => string;
  },
): OfficeAgent[] {
  const visible = threads.filter(
    (thread) =>
      thread.deletedAt === null &&
      thread.archivedAt === null &&
      thread.settledOverride !== "settled" &&
      thread.isSideChat !== true,
  );
  const byKey = new Map(threads.map((thread) => [officeThreadKey(thread), thread]));
  const children = new Map<string, Map<string, OfficeSubagent>>();
  for (const thread of visible) {
    let root = thread;
    const seen = new Set([officeThreadKey(root)]);
    while (root.lineage.relationshipToParent === "subagent" && root.lineage.parentThreadId) {
      const parentKey = officeThreadKey({
        environmentId: root.environmentId,
        id: root.lineage.parentThreadId,
      });
      const parent = byKey.get(parentKey);
      if (!parent || seen.has(parentKey)) break;
      seen.add(parentKey);
      root = parent;
    }
    const rootKey = officeThreadKey(root);
    let group = children.get(rootKey);
    if (!group) {
      group = new Map();
      children.set(rootKey, group);
    }
    if (thread.lineage.relationshipToParent === "subagent") {
      const state = officeAgentState(thread, options.connected(thread), options.now);
      if (state === "working" || state === "waiting") {
        group.set(officeThreadKey(thread), {
          key: officeThreadKey(thread),
          title: thread.title,
          state,
          approval: thread.hasPendingApprovals,
        });
      }
    }
    // Provider-native tasks may not have their own thread shell. Prefer a
    // shell when available, so a task and its child never produce two sprites.
    if (!options.connected(thread)) continue;
    for (const task of thread.pendingBackgroundTasks) {
      if (task.kind !== "subagent") continue;
      if (
        "childThreadId" in task &&
        task.childThreadId &&
        byKey.has(officeThreadKey({ environmentId: thread.environmentId, id: task.childThreadId }))
      )
        continue;
      const key = `${officeThreadKey(thread)}:task:${task.taskId}`;
      group.set(key, {
        key,
        title: task.description ?? "Subagent",
        state: "working",
        approval: false,
      });
    }
  }
  return visible
    .filter((thread) => thread.lineage.relationshipToParent !== "subagent")
    .map((thread) => ({
      key: officeThreadKey(thread),
      thread,
      projectName: options.projectName(thread),
      state: officeAgentState(thread, options.connected(thread), options.now),
      subagents: [...(children.get(officeThreadKey(thread))?.values() ?? [])],
    }));
}

export type OfficeScope = "all" | "active" | "recent";

export function filterOfficeRoster(roster: readonly OfficeAgent[], scope: OfficeScope) {
  const priority = { waiting: 0, working: 1, error: 2, idle: 3, snoozed: 4, offline: 5 };
  return [...roster]
    .sort(
      (a, b) =>
        priority[a.state] - priority[b.state] ||
        b.thread.updatedAt.localeCompare(a.thread.updatedAt),
    )
    .filter(
      (agent, index) =>
        scope === "all" ||
        agent.state === "working" ||
        agent.state === "waiting" ||
        agent.subagents.length > 0 ||
        (scope === "recent" && (agent.state === "error" || index < 20)),
    );
}
