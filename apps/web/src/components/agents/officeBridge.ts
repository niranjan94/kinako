import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";

export type OfficeMessage = { type: string; [key: string]: unknown };
export type OfficeSeat = {
  palette?: number | undefined;
  hueShift?: number | undefined;
  seatId?: string | null | undefined;
};
export interface OfficeAgent {
  key: string;
  thread: EnvironmentThreadShell;
  projectName: string;
  state: "working" | "waiting" | "idle" | "snoozed" | "error" | "offline";
  subagents: readonly OfficeSubagent[];
}
export interface OfficeSubagent {
  key: string;
  title: string;
  state: "working" | "waiting";
  approval: boolean;
}

export function officeAgentState(
  thread: EnvironmentThreadShell,
  connected = true,
  now = new Date().toISOString(),
): OfficeAgent["state"] {
  if (effectiveSnoozed(thread, { now })) return "snoozed";
  if (!connected) return "offline";
  if (
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    thread.pendingSubagentRequest ||
    thread.runtime?.status === "waiting"
  )
    return "waiting";
  if (threadRuntimeIsActive(thread.runtime)) return "working";
  if (thread.runtime?.lastError || thread.runtime?.status === "failed") return "error";
  return "idle";
}

export function officeThreadKey(thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) {
  return threadKey({ environmentId: thread.environmentId, threadId: thread.id });
}

export class OfficeBridge {
  private nextId = 1;
  private ids = new Map<string, number>();
  private previous = new Map<string, { metadata: string; activity: string }>();
  private agents = new Map<number, OfficeAgent>();
  private subagents = new Map<string, readonly OfficeSubagent[]>();

  constructor(private send: (message: OfficeMessage) => void) {}

  agent(id: number) {
    return this.agents.get(id);
  }

  seatsByThread(seats: Record<string, OfficeSeat>) {
    return Object.fromEntries(
      [...this.agents].flatMap(([id, agent]) => (seats[id] ? [[agent.key, seats[id]]] : [])),
    );
  }

  sync(roster: readonly OfficeAgent[], seats: Record<string, OfficeSeat>) {
    const keys = new Set(roster.map((agent) => agent.key));
    for (const [id, agent] of this.agents) {
      if (keys.has(agent.key)) continue;
      this.send({ type: "agentClosed", id });
      this.agents.delete(id);
      this.ids.delete(agent.key);
      this.previous.delete(agent.key);
      this.subagents.delete(agent.key);
    }
    const additions: { id: number; agent: OfficeAgent }[] = [];
    for (const agent of roster) {
      let id = this.ids.get(agent.key);
      if (id === undefined) {
        id = this.nextId++;
        this.ids.set(agent.key, id);
        additions.push({ id, agent });
      }
      this.agents.set(id, agent);
    }
    if (additions.length > 0) {
      this.send({
        type: "existingAgents",
        agents: additions.map(({ id }) => id),
        agentMeta: Object.fromEntries(
          additions.map(({ id, agent }) => [id, seats[agent.key] ?? {}]),
        ),
        directoryNames: Object.fromEntries(
          additions.map(({ id, agent }) => [id, agent.projectName]),
        ),
        externalAgents: {},
      });
    }
    for (const agent of roster) {
      const id = this.ids.get(agent.key)!;
      const metadata = JSON.stringify([
        agent.thread.title,
        agent.projectName,
        agent.thread.lineage,
        agent.state === "snoozed",
      ]);
      const activity = JSON.stringify([
        agent.state,
        agent.thread.hasPendingApprovals,
        agent.thread.snoozedUntil,
        agent.subagents,
      ]);
      const previous = this.previous.get(agent.key);
      this.previous.set(agent.key, { metadata, activity });
      if (previous?.metadata !== metadata) {
        this.send({
          type: "agentTeamInfo",
          id,
          agentName: `${agent.state === "snoozed" ? "Zzz · " : ""}${agent.thread.title}`,
          teamName: agent.projectName,
          isTeamLead: false,
        });
      }
      if (previous?.metadata !== metadata || previous?.activity !== activity) {
        this.send({
          type: "kinakoAgentState",
          id,
          state: agent.state,
          approval: agent.thread.hasPendingApprovals,
          title: agent.thread.title,
          snoozedUntil: agent.thread.snoozedUntil,
          subagentCount: agent.subagents.length,
        });
      }
      if (previous?.activity === activity) continue;
      const previousChildren = this.subagents.get(agent.key) ?? [];
      for (const child of previousChildren) {
        if (!agent.subagents.some((current) => current.key === child.key)) {
          this.send({ type: "subagentClear", id, parentToolId: child.key });
        }
      }
      // Native subagent activity survives agentToolsClear; otherwise a parent
      // changing state would despawn children that are still working.
      for (const child of agent.subagents) {
        const old = previousChildren.find((current) => current.key === child.key);
        if (old && JSON.stringify(old) === JSON.stringify(child)) continue;
        if (old) this.send({ type: "subagentClear", id, parentToolId: child.key });
        this.send({
          type: "subagentToolStart",
          id,
          parentToolId: child.key,
          toolId: "kinako:activity",
          status: `${child.state === "waiting" ? "Waiting for input" : "Working"}: ${child.title}`,
        });
        if (child.state === "waiting") {
          this.send({
            type: "subagentToolDone",
            id,
            parentToolId: child.key,
            toolId: "kinako:activity",
          });
        }
        if (child.approval)
          this.send({ type: "subagentToolPermission", id, parentToolId: child.key });
      }
      this.subagents.set(agent.key, agent.subagents);
      this.send({ type: "agentToolsClear", id });
      if (agent.state !== "idle" && agent.state !== "snoozed") {
        this.send({
          type: "agentToolStart",
          id,
          toolId: "kinako:activity",
          toolName: "KinakoActivity",
          status:
            agent.state === "working"
              ? "Working"
              : agent.state === "error"
                ? "Error"
                : agent.state === "offline"
                  ? "Environment disconnected"
                  : "Waiting for input",
        });
      }
      this.send({
        type: "agentStatus",
        id,
        // The pinned frontend treats other status strings as inactive without a
        // successful-completion bubble or sound.
        status: agent.state === "working" ? "active" : agent.state,
        awaitingInput: agent.state === "waiting",
      });
      if (agent.thread.hasPendingApprovals) this.send({ type: "agentToolPermission", id });
    }
  }
}
