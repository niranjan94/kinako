import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { buildOfficeRoster, filterOfficeRoster } from "./officeRoster";
import { officeThreadKey } from "./officeBridge";

const now = "2026-10-21T12:00:00Z";
const options = { now, connected: () => true, projectName: () => "Project" };

function thread(id: string, overrides: Partial<EnvironmentThreadShell> = {}) {
  return {
    id: ThreadId.make(id),
    environmentId: EnvironmentId.make("local"),
    title: id,
    runtime: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingBackgroundTasks: [],
    deletedAt: null,
    archivedAt: null,
    settledOverride: null,
    snoozedUntil: null,
    updatedAt: now,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
    ...overrides,
  } as EnvironmentThreadShell;
}

function working(id: string, overrides: Partial<EnvironmentThreadShell> = {}) {
  return thread(id, {
    runtime: {
      status: "running",
      lastError: null,
      updatedAt: now,
    } as EnvironmentThreadShell["runtime"],
    ...overrides,
  });
}

function child(id: string, parent: EnvironmentThreadShell) {
  return working(id, {
    environmentId: parent.environmentId,
    lineage: {
      parentThreadId: parent.id,
      relationshipToParent: "subagent",
      rootThreadId: parent.id,
    },
  });
}

describe("office roster", () => {
  it("includes all six open threads plus the snoozed thread and never includes settled threads", () => {
    const threads = [
      working("one"),
      working("two"),
      ...["three", "four", "five", "six"].map((id) => thread(id)),
      thread("snoozed", { snoozedUntil: "2026-10-21T13:00:00Z" }),
      working("settled", { settledOverride: "settled" }),
      thread("archived", { archivedAt: now }),
      thread("deleted", { deletedAt: now }),
      thread("side-chat", {
        lineage: {
          parentThreadId: ThreadId.make("one"),
          relationshipToParent: "fork",
          rootThreadId: ThreadId.make("one"),
          sideChat: true,
        },
      }),
    ];
    const roster = buildOfficeRoster(threads, options);
    expect(filterOfficeRoster(roster, "all")).toHaveLength(7);
    expect(roster.filter((agent) => agent.state === "working")).toHaveLength(2);
    expect(roster.find((agent) => agent.thread.id === "snoozed")?.state).toBe("snoozed");
    for (const scope of ["all", "active", "recent"] as const) {
      expect(filterOfficeRoster(roster, scope).some((agent) => agent.thread.id === "settled")).toBe(
        false,
      );
    }
    expect(filterOfficeRoster(roster, "active")).toHaveLength(2);
  });

  it("wakes snoozed threads on expiry or an actionable request, while background work stays snoozed", () => {
    const snoozed = working("snoozed", { snoozedUntil: "2026-10-21T13:00:00Z" });
    expect(buildOfficeRoster([snoozed], options)[0]?.state).toBe("snoozed");
    expect(
      buildOfficeRoster([snoozed], { ...options, now: "2026-10-21T13:00:00Z" })[0]?.state,
    ).toBe("working");
    expect(buildOfficeRoster([{ ...snoozed, hasPendingApprovals: true }], options)[0]?.state).toBe(
      "waiting",
    );
  });

  it("groups active and nested subagents with their parent without counting them as threads", () => {
    const parent = thread("parent");
    const active = child("active", parent);
    const nested = child("nested", active);
    const completed = { ...child("completed", parent), runtime: null };
    const settled = { ...child("settled", parent), settledOverride: "settled" as const };
    const roster = buildOfficeRoster([parent, active, nested, completed, settled], options);
    expect(roster).toHaveLength(1);
    expect(roster[0]?.subagents.map((agent) => agent.title)).toEqual(["active", "nested"]);
    expect(filterOfficeRoster(roster, "active")).toHaveLength(1);
    expect(
      buildOfficeRoster([parent, { ...active, runtime: null }], options)[0]?.subagents,
    ).toEqual([]);
  });

  it("keeps children environment-local and represents native tasks without duplicate sprites", () => {
    const parent = thread("parent");
    const active = child("active", parent);
    const remoteParent = { ...parent, environmentId: EnvironmentId.make("remote") };
    const remoteChild = child("active", remoteParent);
    const withTasks = {
      ...parent,
      pendingBackgroundTasks: [
        { kind: "subagent" as const, taskId: "child-task", childThreadId: active.id },
        { kind: "subagent" as const, taskId: "native-task", description: "Native researcher" },
        { kind: "command" as const, taskId: "shell" },
      ],
    };
    const roster = buildOfficeRoster([withTasks, active, remoteParent, remoteChild], options);
    expect(roster).toHaveLength(2);
    expect(roster[0]?.subagents.map((agent) => agent.title)).toEqual([
      "Native researcher",
      "active",
    ]);
    expect(roster[1]?.subagents.map((agent) => agent.key)).toEqual([officeThreadKey(remoteChild)]);
  });

  it("hides cached child activity while disconnected and restores it on reconnect", () => {
    const parent = thread("parent", {
      pendingBackgroundTasks: [{ kind: "subagent", taskId: "native", description: "Research" }],
    });
    const threads = [parent, child("child", parent)];
    const connected = buildOfficeRoster(threads, options);
    expect(connected[0]?.subagents).toHaveLength(2);

    const offline = buildOfficeRoster(threads, { ...options, connected: () => false });
    expect(offline[0]?.state).toBe("offline");
    expect(offline[0]?.subagents).toEqual([]);
    expect(filterOfficeRoster(offline, "active")).toEqual([]);
    expect(filterOfficeRoster(offline, "all")).toHaveLength(1);

    expect(buildOfficeRoster(threads, options)[0]?.subagents).toEqual(connected[0]?.subagents);
  });
});
