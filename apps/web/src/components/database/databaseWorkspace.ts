import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  releaseDatabaseResources,
  type DatabaseWorkspaceTab,
} from "@t3tools/client-runtime/state/database";
import {
  DatabaseSessionId,
  type DatabaseConnection,
  type EnvironmentId,
  type ProjectId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { AtomRegistry } from "effect/reactivity/AtomRegistry";
import { randomUUID } from "../../lib/utils";
import { ensureLocalApi } from "../../localApi";
import { databaseState } from "../../state/database";
import { useTerminalUiStateStore } from "../../terminalUiStateStore";
import { databaseErrorMessage, databaseValue } from "./databaseHooks";

/** A thread's database workspace; its tabs open in that thread's bottom drawer. */
export interface DatabaseWorkspaceScope {
  registry: AtomRegistry;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadRef: ScopedThreadRef;
}

const workspaceAtom = (threadRef: ScopedThreadRef) =>
  databaseState.workspaces(scopedThreadKey(threadRef));

export const findDatabaseTab = (
  registry: AtomRegistry,
  threadRef: ScopedThreadRef,
  id: string,
): DatabaseWorkspaceTab | undefined =>
  registry.get(workspaceAtom(threadRef)).tabs.find((tab) => tab.id === id);

export function updateDatabaseTab(
  registry: AtomRegistry,
  threadRef: ScopedThreadRef,
  id: string,
  patch: Partial<DatabaseWorkspaceTab>,
) {
  const atom = workspaceAtom(threadRef);
  const workspace = registry.get(atom);
  registry.set(atom, {
    ...workspace,
    tabs: workspace.tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)),
  });
}

/** Shows a database tab in the bottom drawer, or the drawer's terminals for `null`. */
export function showDatabaseTab(
  registry: AtomRegistry,
  threadRef: ScopedThreadRef,
  id: string | null,
) {
  const atom = workspaceAtom(threadRef);
  const workspace = registry.get(atom);
  if (workspace.activeId !== id) registry.set(atom, { ...workspace, activeId: id });
  if (id !== null) useTerminalUiStateStore.getState().revealTerminalDrawer(threadRef);
}

function addDatabaseTab(scope: DatabaseWorkspaceScope, tab: DatabaseWorkspaceTab) {
  const atom = workspaceAtom(scope.threadRef);
  const workspace = scope.registry.get(atom);
  scope.registry.set(atom, { ...workspace, tabs: [...workspace.tabs, tab] });
  showDatabaseTab(scope.registry, scope.threadRef, tab.id);
}

export async function ensureDatabaseSession(
  scope: DatabaseWorkspaceScope,
  tabId: string,
  connection: DatabaseConnection,
) {
  const { registry, environmentId, projectId, threadRef } = scope;
  const existing = findDatabaseTab(registry, threadRef, tabId)?.sessionId;
  if (existing) return existing;
  const sessionId = DatabaseSessionId.make(randomUUID());
  updateDatabaseTab(registry, threadRef, tabId, { sessionId });
  databaseValue(
    await databaseState.openSession.run(registry, {
      environmentId,
      input: { projectId, connectionId: connection.id, sessionId },
    }),
  );
  if (!findDatabaseTab(registry, threadRef, tabId)) {
    await releaseDatabaseResources(
      databaseState,
      registry,
      { environmentId, projectId },
      { sessionId },
    );
    throw new Error("The query tab has closed.");
  }
  return sessionId;
}

export async function newDatabaseConsole(
  scope: DatabaseWorkspaceScope,
  connection: DatabaseConnection,
) {
  const { registry, threadRef } = scope;
  const consoleNumbers = registry
    .get(workspaceAtom(threadRef))
    .tabs.map((tab) => Number(/^Console (\d+)$/.exec(tab.title)?.[1] ?? 0));
  const id = randomUUID();
  addDatabaseTab(scope, {
    id,
    connectionId: connection.id,
    title: `Console ${Math.max(0, ...consoleNumbers) + 1}`,
    sql: "",
    loading: true,
  });
  return await (async () => {
    await ensureDatabaseSession(scope, id, connection);
    updateDatabaseTab(registry, threadRef, id, { loading: false });
  })().catch(async (error: unknown) => {
    if (!findDatabaseTab(registry, threadRef, id)) return;
    updateDatabaseTab(registry, threadRef, id, {
      loading: false,
      error: databaseErrorMessage(error),
      sessionId: undefined,
    });
  });
}

export function openDatabaseTable(
  scope: DatabaseWorkspaceScope,
  connection: DatabaseConnection,
  schema: string,
  object: string,
) {
  const { registry, environmentId, projectId, threadRef } = scope;
  const existing = registry
    .get(workspaceAtom(threadRef))
    .tabs.find(
      (tab) =>
        tab.connectionId === connection.id &&
        tab.table?.schema === schema &&
        tab.table.object === object,
    );
  if (existing) {
    showDatabaseTab(registry, threadRef, existing.id);
    return;
  }
  addDatabaseTab(scope, {
    id: randomUUID(),
    connectionId: connection.id,
    title: `${schema}.${object}`,
    sql: "",
    loading: false,
    table: { schema, object, where: "", orderBy: "", offset: 0, after: null },
  });
  void databaseState.introspect.run(registry, {
    environmentId,
    input: { projectId, connectionId: connection.id, scope: { kind: "columns", schema, object } },
  });
}

/** Closes a tab, asking first when a console holds SQL not saved to a file. */
export async function closeDatabaseTab(scope: DatabaseWorkspaceScope, tab: DatabaseWorkspaceTab) {
  const { registry, environmentId, projectId, threadRef } = scope;
  if (
    !tab.table &&
    tab.sql.trim() &&
    tab.sql !== tab.savedSql &&
    !(await ensureLocalApi().dialogs.confirm(
      `Close ${tab.title}?\nIts SQL is not saved to a file and will be discarded.`,
      { variant: "destructive" },
    ))
  )
    return;
  const atom = workspaceAtom(threadRef);
  const workspace = registry.get(atom);
  const index = workspace.tabs.findIndex((item) => item.id === tab.id);
  if (index < 0) return;
  const tabs = workspace.tabs.filter((item) => item.id !== tab.id);
  registry.set(atom, {
    tabs,
    activeId:
      workspace.activeId === tab.id
        ? ((tabs[index] ?? tabs[index - 1])?.id ?? null)
        : workspace.activeId,
  });
  void releaseDatabaseResources(databaseState, registry, { environmentId, projectId }, tab);
}
