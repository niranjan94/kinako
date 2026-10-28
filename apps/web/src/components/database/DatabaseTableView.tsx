import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  databaseCacheKey,
  type DatabaseWorkspaceTab,
} from "@t3tools/client-runtime/state/database";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { PlayIcon, RefreshCwIcon } from "lucide-react";
import { useContext, useEffect, useEffectEvent } from "react";
import { useStableCallback } from "../../hooks/useStableCallback";
import { databaseState } from "../../state/database";
import { useEnvironment } from "../../state/environments";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { DatabaseGrid } from "./DatabaseGrid";
import { DatabaseToolbarButton } from "./DatabaseToolbarButton";
import { databaseErrorMessage, databaseValue } from "./databaseHooks";

type TableTab = DatabaseWorkspaceTab & { table: NonNullable<DatabaseWorkspaceTab["table"]> };
const isDatabaseTableTab = (tab: DatabaseWorkspaceTab): tab is TableTab => tab.table !== undefined;

// Tab ids are unique across threads, and loads must not overlap even if the view remounts.
const pending = new Set<string>();

export function DatabaseTableView({
  environmentId,
  projectId,
  threadKey,
  tabId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadKey: string;
  tabId: string;
}) {
  const workspaceAtom = databaseState.workspaces(threadKey);
  const tab = useAtomValue(workspaceAtom).tabs.find((item) => item.id === tabId);
  if (!tab || !isDatabaseTableTab(tab)) return null;
  return (
    <TableView
      environmentId={environmentId}
      projectId={projectId}
      threadKey={threadKey}
      tab={tab}
    />
  );
}

function TableView({
  environmentId,
  projectId,
  threadKey,
  tab,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadKey: string;
  tab: TableTab;
}) {
  const registry = useContext(RegistryContext);
  const workspaceAtom = databaseState.workspaces(threadKey);
  const allowed = useAtomValue(databaseState.browseTable.permissionAtom(environmentId));
  const connected = useEnvironment(environmentId)?.connection.phase === "connected";
  const current = (id: string) => registry.get(workspaceAtom).tabs.find((item) => item.id === id);
  const updateTab = (id: string, patch: Partial<DatabaseWorkspaceTab>) => {
    const workspace = registry.get(workspaceAtom);
    registry.set(workspaceAtom, {
      ...workspace,
      tabs: workspace.tabs.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    });
  };
  const loadTable = async (tabId: string, more = false) => {
    const start = current(tabId);
    if (!start?.table || pending.has(tabId)) return;
    pending.add(tabId);
    updateTab(tabId, { loading: true, error: undefined });
    const table = start.table;
    return await (async () => {
      const result = databaseValue(
        await databaseState.browseTable.run(registry, {
          environmentId,
          input: {
            projectId,
            connectionId: start.connectionId,
            ...(start.database !== undefined ? { database: start.database } : {}),
            schema: table.schema,
            object: table.object,
            where: table.where,
            orderBy: table.orderBy,
            offset: more ? table.offset : 0,
            ...(more && table.after ? { after: table.after } : {}),
          },
        }),
      );
      if (!current(tabId)) return;
      const oldRows = more && start.result?.kind === "rows" ? start.result.rows : [];
      updateTab(tabId, {
        result: {
          kind: "rows",
          columns: result.columns,
          rows: [...oldRows, ...result.rows],
          hasMore: result.hasMore,
          durationMs: 0,
        },
        table: { ...table, offset: result.nextOffset, after: result.nextAfter },
        loading: false,
      });
    })()
      .catch(async (error: unknown) => {
        if (!current(tabId)) return;
        updateTab(tabId, {
          loading: false,
          error: databaseErrorMessage(error),
          // Rows from the previous filter would read as the answer to the failed one.
          ...(more ? {} : { result: undefined }),
        });
      })
      .finally(() => {
        pending.delete(tabId);
      });
  };
  const reload = useEffectEvent((id: string) => void loadTable(id));
  const unloaded =
    allowed && connected && !tab.result && !tab.loading && !tab.error ? tab.id : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads a connected table tab that has no result yet from the database server
  useEffect(() => {
    if (unloaded) reload(unloaded);
  }, [unloaded]);
  const onLoadMore = useStableCallback(() => {
    if (!tab.loading && tab.result?.kind === "rows" && tab.result.hasMore)
      void loadTable(tab.id, true);
  });
  const onOrderBy = useStableCallback((orderBy: string) => {
    if (tab.loading) return;
    updateTab(tab.id, { table: { ...tab.table, orderBy } });
    void loadTable(tab.id);
  });
  const columnMetadata = useAtomValue(
    databaseState.metadata(
      databaseCacheKey(environmentId, {
        projectId,
        connectionId: tab.connectionId,
        ...(tab.database !== undefined ? { database: tab.database } : {}),
        scope: { kind: "columns", schema: tab.table.schema, object: tab.table.object },
        revision: registry.get(databaseState.revision(environmentId)),
      }),
    ),
  );
  if (!allowed) return <p className="p-3 text-sm">Database access requires terminal permission.</p>;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <form
        className="flex h-8 shrink-0 items-center gap-1 border-b px-1"
        aria-label={`Filter ${tab.title}`}
        onSubmit={(event) => {
          event.preventDefault();
          void loadTable(tab.id);
        }}
      >
        <DatabaseToolbarButton
          type="button"
          label="Reload rows"
          disabled={tab.loading}
          onClick={() => void loadTable(tab.id)}
        >
          <RefreshCwIcon />
        </DatabaseToolbarButton>
        <div className="min-w-0 flex-1">
          <Input
            size="compact"
            unstyled
            font="mono"
            aria-label="WHERE condition"
            placeholder="WHERE condition"
            value={tab.table.where}
            onChange={(event) =>
              updateTab(tab.id, { table: { ...tab.table, where: event.target.value } })
            }
          />
        </div>
        <div className="min-w-0 flex-1 border-l">
          <Input
            size="compact"
            unstyled
            font="mono"
            aria-label="ORDER BY"
            placeholder="ORDER BY column"
            value={tab.table.orderBy}
            onChange={(event) =>
              updateTab(tab.id, { table: { ...tab.table, orderBy: event.target.value } })
            }
          />
        </div>
        <DatabaseToolbarButton label="Apply filter (Enter)" type="submit" disabled={tab.loading}>
          <PlayIcon />
        </DatabaseToolbarButton>
      </form>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {tab.error && (
          <p
            role="alert"
            className="break-words border-b bg-destructive/5 p-3 font-mono text-xs text-destructive-foreground"
          >
            {tab.error}
          </p>
        )}
        {tab.result?.kind === "rows" ? (
          <DatabaseGrid
            key={tab.id}
            columns={tab.result.columns}
            rows={tab.result.rows}
            {...(columnMetadata?.kind === "columns" ? { columnInfo: columnMetadata.columns } : {})}
            hasMore={tab.result.hasMore}
            expires={false}
            exportName={tab.title}
            loading={tab.loading}
            onLoadMore={onLoadMore}
            orderBy={tab.table.orderBy}
            onOrderBy={onOrderBy}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center gap-2 px-6 text-xs text-muted-foreground">
            {!tab.error && <Spinner size="sm" tone="muted" />}
            {tab.error ? "Fix the filter and apply it again." : "Loading rows…"}
          </div>
        )}
      </div>
    </div>
  );
}
