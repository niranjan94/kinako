import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";

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
  state: "working" | "waiting" | "idle" | "error" | "offline";
}

export function officeAgentState(
  thread: EnvironmentThreadShell,
  connected = true,
): OfficeAgent["state"] {
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

export function officeThreadKey(thread: EnvironmentThreadShell) {
  return threadKey({ environmentId: thread.environmentId, threadId: thread.id });
}

export class OfficeBridge {
  private nextId = 1;
  private ids = new Map<string, number>();
  private previous = new Map<string, { metadata: string; activity: string }>();
  private agents = new Map<number, OfficeAgent>();

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
      ]);
      const activity = JSON.stringify([agent.state, agent.thread.hasPendingApprovals]);
      const previous = this.previous.get(agent.key);
      this.previous.set(agent.key, { metadata, activity });
      if (previous?.metadata !== metadata) {
        this.send({
          type: "agentTeamInfo",
          id,
          agentName: agent.thread.title,
          teamName: agent.projectName,
          isTeamLead: false,
        });
      }
      if (previous?.activity === activity) continue;
      this.send({ type: "agentToolsClear", id });
      if (agent.state !== "idle") {
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
        status:
          agent.state === "working"
            ? "active"
            : agent.state === "error" || agent.state === "offline"
              ? agent.state
              : "waiting",
        awaitingInput: agent.state === "waiting",
      });
      this.send({
        type: "kinakoAgentState",
        id,
        state: agent.state,
        approval: agent.thread.hasPendingApprovals,
      });
      if (agent.thread.hasPendingApprovals) this.send({ type: "agentToolPermission", id });
    }
  }
}
