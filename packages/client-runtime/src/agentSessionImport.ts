import type { AgentSessionListItem, ServerConfig } from "@t3tools/contracts";

/** A session written to this recently may still be open in a terminal. */
const RECENTLY_ACTIVE_MS = 5 * 60 * 1000;

/** Whether an environment can list and import a project's terminal sessions. */
export function supportsAgentSessionImport(
  serverConfig: Pick<ServerConfig, "environment"> | null | undefined,
): boolean {
  return serverConfig?.environment.capabilities.agentSessionImport === true;
}

/** Whether a listed session looks like it is still running in a terminal. */
export function isAgentSessionRecentlyActive(
  session: Pick<AgentSessionListItem, "updatedAt">,
  nowMs: number,
): boolean {
  return nowMs - Date.parse(session.updatedAt) < RECENTLY_ACTIVE_MS;
}
