import {
  WS_METHODS,
  type DatabaseConnection,
  type DatabaseConnectionId,
  type EnvironmentId,
  type DatabaseConnectionDraft,
  type DatabaseIntrospectResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

export function createDatabaseState<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, ER>,
  options: { restoreWorkspace?: (key: string) => DatabaseWorkspace | null } = {},
) {
  const revision = Atom.family((_id: EnvironmentId) => Atom.make(0));
  const connections = Atom.family((_key: string) => Atom.make<readonly DatabaseConnection[]>([]));
  const completion = Atom.family((_key: string) =>
    Atom.make<Record<string, Record<string, readonly string[]>>>({}),
  );
  const metadata = Atom.family((_key: string) => Atom.make<DatabaseIntrospectResult | null>(null));
  const changed = (
    target: { environmentId: EnvironmentId },
    registry: import("effect/reactivity/AtomRegistry").AtomRegistry,
  ) =>
    Effect.sync(() => {
      registry.set(
        revision(target.environmentId),
        registry.get(revision(target.environmentId)) + 1,
      );
    });
  return {
    revision,
    connections,
    metadata,
    completion,
    workspaces: Atom.family((key: string) =>
      // Settings temporarily unmounts the panel; retain its SQL and session ownership.
      Atom.make<DatabaseWorkspace>(
        options.restoreWorkspace?.(key) ?? { tabs: [], activeId: null },
      ).pipe(Atom.keepAlive),
    ),
    listConnections: createEnvironmentRpcCommand(runtime, {
      label: "database:list",
      tag: WS_METHODS.databaseListConnections,
      concurrency: {
        mode: "latest",
        key: ({ environmentId, input }) => databaseCacheKey(environmentId, input),
      },
      onSuccess: (target, registry, result) =>
        Effect.sync(() =>
          registry.set(
            connections(databaseCacheKey(target.environmentId, target.input)),
            result.connections,
          ),
        ),
    }),
    saveConnection: createEnvironmentRpcCommand(runtime, {
      label: "database:save",
      tag: WS_METHODS.databaseSaveConnection,
      onSuccess: changed,
    }),
    deleteConnection: createEnvironmentRpcCommand(runtime, {
      label: "database:delete",
      tag: WS_METHODS.databaseDeleteConnection,
      onSuccess: changed,
    }),
    testConnection: createEnvironmentRpcCommand(runtime, {
      label: "database:test",
      tag: WS_METHODS.databaseTestConnection,
    }),
    introspect: createEnvironmentRpcCommand(runtime, {
      label: "database:introspect",
      tag: WS_METHODS.databaseIntrospect,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => databaseCacheKey(environmentId, input),
      },
      onSuccess: (target, registry, result) =>
        Effect.sync(() => {
          const revisionValue = registry.get(revision(target.environmentId));
          registry.set(
            metadata(
              databaseCacheKey(target.environmentId, { ...target.input, revision: revisionValue }),
            ),
            result,
          );
          const atom = completion(
            databaseCacheKey(target.environmentId, { connectionId: target.input.connectionId }),
          );
          const previous = registry.get(atom);
          const scope = target.input.scope;
          if (result.kind === "schemas")
            registry.set(atom, {
              ...Object.fromEntries(result.schemas.map((schema) => [schema.name, {}])),
              ...previous,
            });
          if (result.kind === "objects" && scope.kind === "objects")
            registry.set(atom, {
              ...previous,
              [scope.schema]: Object.fromEntries(
                result.objects.map((table) => [
                  table.name,
                  previous[scope.schema]?.[table.name] ?? [],
                ]),
              ),
            });
          if (result.kind === "columns" && scope.kind === "columns")
            registry.set(atom, {
              ...previous,
              [scope.schema]: {
                ...previous[scope.schema],
                [scope.object]: result.columns.map((column) => column.name),
              },
            });
        }),
    }),
    openSession: createEnvironmentRpcCommand(runtime, {
      label: "database:open-session",
      tag: WS_METHODS.databaseOpenSession,
    }),
    closeSession: createEnvironmentRpcCommand(runtime, {
      label: "database:close-session",
      tag: WS_METHODS.databaseCloseSession,
    }),
    execute: createEnvironmentRpcCommand(runtime, {
      label: "database:execute",
      tag: WS_METHODS.databaseExecute,
    }),
    fetchPage: createEnvironmentRpcCommand(runtime, {
      label: "database:fetch-page",
      tag: WS_METHODS.databaseFetchPage,
    }),
    browseTable: createEnvironmentRpcCommand(runtime, {
      label: "database:browse-table",
      tag: WS_METHODS.databaseBrowseTable,
    }),
    closeQuery: createEnvironmentRpcCommand(runtime, {
      label: "database:close-query",
      tag: WS_METHODS.databaseCloseQuery,
    }),
    cancelQuery: createEnvironmentRpcCommand(runtime, {
      label: "database:cancel-query",
      tag: WS_METHODS.databaseCancelQuery,
    }),
  };
}

export const databaseCacheKey = (environmentId: EnvironmentId, input: object) =>
  JSON.stringify([environmentId, input]);

export interface DatabaseGlobalCopy {
  environmentId: EnvironmentId;
  connection: DatabaseConnection;
}

export function databaseGlobalCoverage(
  copies: readonly DatabaseGlobalCopy[],
  environmentIds: readonly EnvironmentId[],
) {
  const grouped = new Map<DatabaseConnectionId, DatabaseGlobalCopy[]>();
  for (const copy of copies) {
    if (copy.connection.level !== "global") continue;
    grouped.set(copy.connection.id, [...(grouped.get(copy.connection.id) ?? []), copy]);
  }
  return [...grouped].map(([id, versions]) => {
    const newest = versions.reduce((best, copy) =>
      copy.connection.updatedAt > best.connection.updatedAt ? copy : best,
    );
    return {
      id,
      connection: newest.connection,
      copies: versions,
      missing: environmentIds.filter(
        (environmentId) => !versions.some((copy) => copy.environmentId === environmentId),
      ),
      older: versions.filter((copy) => copy.connection.updatedAt < newest.connection.updatedAt),
    };
  });
}

/** One revision and id travel to every destination, including copies created after an offline gap. */
export function databaseGlobalDraft(
  draft: DatabaseConnectionDraft,
  id: DatabaseConnectionId,
  updatedAt: string,
): DatabaseConnectionDraft {
  return { ...draft, id, level: "global", updatedAt };
}

export async function fanOutDatabaseOperation<A>(
  environmentIds: readonly EnvironmentId[],
  run: (environmentId: EnvironmentId) => Promise<A>,
) {
  return Promise.all(
    environmentIds.map(async (environmentId) => {
      try {
        return { environmentId, ok: true as const, value: await run(environmentId) };
      } catch (error) {
        return { environmentId, ok: false as const, error };
      }
    }),
  );
}

export async function releaseDatabaseResources(
  state: Pick<ReturnType<typeof createDatabaseState>, "closeQuery" | "closeSession">,
  registry: import("effect/reactivity/AtomRegistry").AtomRegistry,
  target: { environmentId: EnvironmentId; projectId?: import("@t3tools/contracts").ProjectId },
  resources: {
    queryId?: import("@t3tools/contracts").DatabaseQueryId | undefined;
    sessionId?: import("@t3tools/contracts").DatabaseSessionId | undefined;
  },
) {
  const { environmentId, ...context } = target;
  if (resources.queryId)
    await state.closeQuery.run(registry, {
      environmentId,
      input: { ...context, queryId: resources.queryId },
    });
  if (resources.sessionId)
    await state.closeSession.run(registry, {
      environmentId,
      input: { ...context, sessionId: resources.sessionId },
    });
}

export interface DatabaseWorkspaceTab {
  id: string;
  connectionId: DatabaseConnectionId;
  title: string;
  sql: string;
  filePath?: string;
  /** SQL as last read from or written to `filePath`. */
  savedSql?: string;
  sessionId?: import("@t3tools/contracts").DatabaseSessionId | undefined;
  queryId?: import("@t3tools/contracts").DatabaseQueryId | undefined;
  result?: import("@t3tools/contracts").DatabaseExecuteResult;
  loading: boolean;
  error?: string | undefined;
  table?: {
    schema: string;
    object: string;
    where: string;
    orderBy: string;
    offset: number;
    after: readonly (string | number | boolean | null)[] | null;
  };
}
export interface DatabaseWorkspace {
  tabs: readonly DatabaseWorkspaceTab[];
  activeId: string | null;
}
