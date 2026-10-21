import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  OfficeBridge,
  officeAgentState,
  officeThreadKey,
  type OfficeAgent,
  type OfficeMessage,
} from "./officeBridge";

function agent(
  environment = "local",
  state: OfficeAgent["state"] = "idle",
  overrides: Partial<EnvironmentThreadShell> = {},
): OfficeAgent {
  const thread = {
    id: ThreadId.make("same-thread-id"),
    environmentId: EnvironmentId.make(environment),
    title: "Fix the bug",
    runtime: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    snoozedUntil: null,
    pendingBackgroundTasks: [],
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: ThreadId.make("same-thread-id"),
    },
    ...overrides,
  } as EnvironmentThreadShell;
  return { key: officeThreadKey(thread), thread, projectName: "Project", state, subagents: [] };
}

describe("office thread bridge", () => {
  it("keeps threads from different environments distinct and preserves seating across filtering", () => {
    const messages: OfficeMessage[] = [];
    const bridge = new OfficeBridge((message) => messages.push(message));
    const local = agent();
    const remote = agent("remote");
    bridge.sync([local, remote], {});
    const restored = messages.find((message) => message.type === "existingAgents")!;
    const localId = (restored.agents as number[])[0]!;
    const remoteId = (restored.agents as number[])[1]!;
    expect(localId).not.toBe(remoteId);
    expect(bridge.agent(remoteId)?.thread.environmentId).toBe("remote");
    expect(
      bridge.seatsByThread({ [localId]: { seatId: "chair-a" }, [remoteId]: { seatId: "chair-b" } }),
    ).toEqual({
      [local.key]: { seatId: "chair-a" },
      [remote.key]: { seatId: "chair-b" },
    });
    bridge.sync([remote], {});
    expect(bridge.agent(localId)).toBeUndefined();
    messages.length = 0;
    bridge.sync([local, remote], { [local.key]: { seatId: "chair-a" } });
    const restoredLocal = messages.find((message) => message.type === "existingAgents")!;
    const restoredId = (restoredLocal.agents as number[])[0]!;
    expect(restoredId).not.toBe(localId);
    expect(restoredLocal.agentMeta).toEqual({ [restoredId]: { seatId: "chair-a" } });
  });

  it("sends activity transitions once, so unchanged snapshots do not replay completion notifications", () => {
    const messages: OfficeMessage[] = [];
    const bridge = new OfficeBridge((message) => messages.push(message));
    const working = agent("local", "working");
    bridge.sync([working], {});
    messages.length = 0;
    bridge.sync([working], {});
    expect(messages).toEqual([]);
    bridge.sync([{ ...working, thread: { ...working.thread, title: "Renamed thread" } }], {});
    expect(messages.map((message) => message.type)).toEqual(["agentTeamInfo", "kinakoAgentState"]);
    expect(messages[1]?.title).toBe("Renamed thread");
    messages.length = 0;
    bridge.sync(
      [{ ...working, state: "waiting", thread: { ...working.thread, hasPendingApprovals: true } }],
      {},
    );
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "agentStatus", status: "waiting", awaitingInput: true }),
        expect.objectContaining({ type: "agentToolPermission" }),
      ]),
    );
  });

  it("keeps failures and disconnections inactive without announcing successful completion", () => {
    for (const state of ["error", "offline"] as const) {
      const messages: OfficeMessage[] = [];
      const bridge = new OfficeBridge((message) => messages.push(message));
      bridge.sync([agent("local", state)], {});
      expect(messages.find((message) => message.type === "agentStatus")).toMatchObject({
        status: state,
        awaitingInput: false,
      });
      expect(messages.find((message) => message.type === "agentToolStart")?.status).toBe(
        state === "error" ? "Error" : "Environment disconnected",
      );
      expect(messages.find((message) => message.type === "kinakoAgentState")?.state).toBe(state);
    }
  });

  it("supplies activity text for the package overlay while a thread is running", () => {
    const messages: OfficeMessage[] = [];
    new OfficeBridge((message) => messages.push(message)).sync([agent("local", "working")], {});
    expect(messages.find((message) => message.type === "agentToolStart")?.status).toBe("Working");
  });

  it("uses inactive snoozed status and restores the normal label when the thread wakes", () => {
    const messages: OfficeMessage[] = [];
    const bridge = new OfficeBridge((message) => messages.push(message));
    const snoozed = agent("local", "snoozed", { snoozedUntil: "2026-10-21T13:00:00Z" });
    bridge.sync([snoozed], {});
    expect(messages.find((message) => message.type === "agentStatus")).toMatchObject({
      status: "snoozed",
      awaitingInput: false,
    });
    expect(messages.some((message) => message.type === "agentToolStart")).toBe(false);
    expect(messages.find((message) => message.type === "agentTeamInfo")?.agentName).toBe(
      "Zzz · Fix the bug",
    );
    messages.length = 0;
    bridge.sync([{ ...snoozed, state: "idle" }], {});
    expect(messages.find((message) => message.type === "agentTeamInfo")?.agentName).toBe(
      "Fix the bug",
    );
  });

  it("keeps child sprites through parent transitions and removes them when their work finishes", () => {
    const messages: OfficeMessage[] = [];
    const bridge = new OfficeBridge((message) => messages.push(message));
    const parent = {
      ...agent("local", "working"),
      subagents: [{ key: "child", title: "Research", state: "working" as const, approval: false }],
    };
    bridge.sync([parent], {});
    expect(messages.find((message) => message.type === "subagentToolStart")).toMatchObject({
      parentToolId: "child",
      status: "Working: Research",
    });
    messages.length = 0;
    bridge.sync([{ ...parent, state: "idle" }], {});
    expect(
      messages.some(
        (message) => message.type === "subagentClear" || message.type === "subagentToolStart",
      ),
    ).toBe(false);
    expect(messages.find((message) => message.type === "kinakoAgentState")?.subagentCount).toBe(1);
    messages.length = 0;
    bridge.sync([{ ...parent, subagents: [] }], {});
    expect(messages.find((message) => message.type === "subagentClear")).toMatchObject({
      parentToolId: "child",
    });
  });

  it("stops waiting children without removing them and resumes their activity after input", () => {
    for (const approval of [false, true]) {
      const messages: OfficeMessage[] = [];
      const bridge = new OfficeBridge((message) => messages.push(message));
      const parent = {
        ...agent("local", "waiting"),
        subagents: [{ key: "child", title: "Research", state: "waiting" as const, approval }],
      };
      bridge.sync([parent], {});
      const activity = messages.filter((message) => message.type.startsWith("subagent"));
      expect(activity.map((message) => message.type)).toEqual([
        "subagentToolStart",
        "subagentToolDone",
        ...(approval ? ["subagentToolPermission"] : []),
      ]);
      expect(activity[1]).toMatchObject({ parentToolId: "child", toolId: activity[0]?.toolId });

      messages.length = 0;
      bridge.sync([parent], {});
      expect(messages).toEqual([]);

      bridge.sync(
        [
          {
            ...parent,
            subagents: [{ ...parent.subagents[0]!, state: "working", approval: false }],
          },
        ],
        {},
      );
      expect(messages.some((message) => message.type === "subagentToolStart")).toBe(true);
      expect(
        messages.some(
          (message) =>
            message.type === "subagentToolDone" || message.type === "subagentToolPermission",
        ),
      ).toBe(false);
    }
  });

  it("shows actionable requests ahead of activity and distinguishes errors from idle", () => {
    const idle = agent().thread;
    expect(officeAgentState(idle)).toBe("idle");
    expect(officeAgentState(idle, false)).toBe("offline");
    expect(officeAgentState({ ...idle, hasPendingUserInput: true })).toBe("waiting");
    const runtime = {
      status: "running",
      activeRunId: null,
      providerInstanceId: idle.providerInstanceId,
      providerName: null,
      lastError: null,
      updatedAt: "2026-10-19T00:00:00Z",
    } as const;
    expect(officeAgentState({ ...idle, runtime })).toBe("working");
    expect(officeAgentState({ ...idle, runtime, hasPendingApprovals: true })).toBe("waiting");
    expect(
      officeAgentState({
        ...idle,
        runtime: { ...runtime, status: "failed", lastError: "Provider exited" },
      }),
    ).toBe("error");
  });
});
