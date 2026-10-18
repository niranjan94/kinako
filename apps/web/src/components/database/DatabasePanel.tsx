import { useStableCallback } from "../../hooks/useStableCallback";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  databaseCacheKey,
  releaseDatabaseResources,
  type DatabaseWorkspaceTab,
} from "@t3tools/client-runtime/state/database";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  DatabaseQueryId,
  DatabaseSessionId,
  type DatabaseConnection,
  type EnvironmentId,
  type ProjectId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useContext, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { databaseState } from "../../state/database";
import { projectEnvironment } from "../../state/projects";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { useRightPanelStore } from "../../rightPanelStore";
import { randomUUID } from "../../lib/utils";
import { observeResize } from "../../lib/observeResize";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { DatabaseConnectionDialog } from "./DatabaseConnectionDialog";
import { DatabaseExplorer } from "./DatabaseExplorer";
import { DatabaseGrid } from "./DatabaseGrid";
import { DatabaseSqlEditor, type DatabaseSqlEditorHandle } from "./DatabaseSqlEditor";
import { DatabaseSplit } from "./DatabaseSplit";
import { DatabaseToolbarButton } from "./DatabaseToolbarButton";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuSeparator } from "../ui/menu";
import {
  ChevronDownIcon,
  DatabaseIcon,
  FolderOpenIcon,
  PanelRightIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  SearchIcon,
  Settings2Icon,
  SquareIcon,
  SquareTerminalIcon,
  Table2Icon,
  XIcon,
} from "lucide-react";
import { databaseErrorMessage, databaseValue, useDatabaseConnections } from "./databaseHooks";
import { databasePanelIntent, useDatabasePanelIntent } from "./databasePanelIntent";
import { sqlStatementRanges, sqlWriteRisk, type SqlStatement } from "./sqlStatements";
import { ensureLocalApi } from "../../localApi";
import { createSqlSchemaCompletion } from "./sqlCompletion";
import { persistDatabaseWorkspace } from "./databaseConsoleStorage";

const sqlLocation = (sql: string, offset: number) => {
  const before = sql.slice(0, offset).split("\n");
  return `Line ${before.length}, column ${(before.at(-1)?.length ?? 0) + 1}`;
};

const owners = new Map<string, () => void>();
useRightPanelStore.subscribe((state, previous) => {
  for (const [key, release] of owners) {
    if (
      previous.byThreadKey[key]?.surfaces.some((surface) => surface.kind === "database") &&
      !state.byThreadKey[key]?.surfaces.some((surface) => surface.kind === "database")
    ) {
      release();
      owners.delete(key);
    }
  }
});

export default function DatabasePanel({
  environmentId,
  projectId,
  threadRef,
  workspaceRoot,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadRef: ScopedThreadRef;
  workspaceRoot: string;
}) {
  const registry = useContext(RegistryContext);
  const key = scopedThreadKey(threadRef);
  const workspaceAtom = databaseState.workspaces(key);
  const workspace = useAtomValue(workspaceAtom);
  const { connections, error, loading, allowed } = useDatabaseConnections(environmentId, projectId);
  const canSave = useAtomValue(databaseState.saveConnection.permissionAtom(environmentId));
  const [editing, setEditing] = useState<DatabaseConnection | "new" | null>(null);
  const [selectedConnection, setSelectedConnection] = useState<string>("");
  const [explorerOpen, setExplorerOpen] = useState<boolean | null>(null);
  const [compact, setCompact] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = panel.current;
    if (!element) return;
    return observeResize(element, ([entry]) => {
      if (entry) setCompact(entry.contentRect.width < 760);
    });
  }, []);
  const sqlEditor = useRef<DatabaseSqlEditorHandle>(null);
  const [filter, setFilter] = useState("");
  const [filesOpen, setFilesOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const pending = useRef(new Set<string>());
  const paging = useRef(new Set<string>());
  const tab = workspace.tabs.find((tab) => tab.id === workspace.activeId);
  const selected =
    connections.find((item) => item.id === selectedConnection) ??
    connections.find((item) => item.id === tab?.connectionId) ??
    connections[0];
  const tabConnection = connections.find((item) => item.id === tab?.connectionId);
  const revision = useAtomValue(databaseState.revision(environmentId));
  // Statements can change search_path; their outcomes invalidate the completion source's cache.
  const completionContext = useMemo(
    () => ({ sessionId: tab?.sessionId, result: tab?.result, revision }),
    [tab?.sessionId, tab?.result, revision],
  );
  const completion = useMemo(() => {
    if (!tabConnection) return undefined;
    return createSqlSchemaCompletion(tabConnection.target.engine, async (scope) => {
      const input = {
        projectId,
        connectionId: tabConnection.id,
        scope,
        ...(completionContext.sessionId ? { sessionId: completionContext.sessionId } : {}),
      };
      return databaseValue(
        await databaseState.introspect.run(registry, {
          environmentId,
          input,
        }),
      );
    });
  }, [environmentId, projectId, tabConnection, registry, completionContext]);
  const readFile = useAtomQueryRunner(projectEnvironment.readFile, { refresh: true });
  const probeFile = useAtomQueryRunner(projectEnvironment.readFile, {
    refresh: true,
    reportFailure: false,
  });
  const updateTab = (id: string, patch: Partial<DatabaseWorkspaceTab>) => {
    const current = registry.get(workspaceAtom);
    registry.set(workspaceAtom, {
      ...current,
      tabs: current.tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)),
    });
  };
  const activeTab = (id: string) => registry.get(workspaceAtom).tabs.find((item) => item.id === id);
  const addTab = (next: DatabaseWorkspaceTab) => {
    const current = registry.get(workspaceAtom);
    registry.set(workspaceAtom, { tabs: [...current.tabs, next], activeId: next.id });
  };
  const releaseOwner = useEffectEvent(() => {
    const current = registry.get(workspaceAtom);
    for (const tab of current.tabs) {
      void releaseDatabaseResources(databaseState, registry, { environmentId, projectId }, tab);
    }
    // Closing the panel ends sessions, but reopening it should bring the SQL back.
    registry.set(workspaceAtom, {
      ...current,
      tabs: current.tabs.map(
        ({ sessionId: _session, queryId: _query, result: _result, error: _error, ...tab }) => ({
          ...tab,
          loading: false,
          ...(tab.table ? { table: { ...tab.table, offset: 0, after: null } } : {}),
        }),
      ),
    });
  });
  useEffect(() => {
    owners.set(key, () => releaseOwner());
  }, [key]);
  useEffect(() => {
    persistDatabaseWorkspace(key, registry.get(workspaceAtom));
    return registry.subscribe(workspaceAtom, (next) => persistDatabaseWorkspace(key, next));
  }, [key, registry, workspaceAtom]);
  const ensureSession = async (tabId: string, connection: DatabaseConnection) => {
    const existing = activeTab(tabId)?.sessionId;
    if (existing) return existing;
    const sessionId = DatabaseSessionId.make(randomUUID());
    updateTab(tabId, { sessionId });
    databaseValue(
      await databaseState.openSession.run(registry, {
        environmentId,
        input: { projectId, connectionId: connection.id, sessionId },
      }),
    );
    if (!activeTab(tabId)) {
      await releaseDatabaseResources(
        databaseState,
        registry,
        { environmentId, projectId },
        { sessionId },
      );
      throw new Error("The query tab has closed.");
    }
    return sessionId;
  };
  const newQuery = async (connection: DatabaseConnection) => {
    databasePanelIntent.consume(threadRef);
    const next: DatabaseWorkspaceTab = {
      id: randomUUID(),
      connectionId: connection.id,
      title: `Console ${Math.max(0, ...registry.get(workspaceAtom).tabs.map((item) => Number(/^Console (\d+)$/.exec(item.title)?.[1] ?? 0))) + 1}`,
      sql: "",
      loading: true,
    };
    addTab(next);
    if ((panel.current?.clientWidth ?? 0) < 760) setExplorerOpen(false);
    try {
      await ensureSession(next.id, connection);
      updateTab(next.id, { loading: false });
    } catch (error) {
      updateTab(next.id, {
        loading: false,
        error: databaseErrorMessage(error),
        sessionId: undefined,
      });
    }
  };
  const loadTable = async (tabId: string, more = false) => {
    const current = activeTab(tabId);
    if (!current?.table || pending.current.has(tabId)) return;
    pending.current.add(tabId);
    updateTab(tabId, { loading: true, error: undefined });
    try {
      const table = current.table;
      const result = databaseValue(
        await databaseState.browseTable.run(registry, {
          environmentId,
          input: {
            projectId,
            connectionId: current.connectionId,
            schema: table.schema,
            object: table.object,
            where: table.where,
            orderBy: table.orderBy,
            offset: more ? table.offset : 0,
            ...(more && table.after ? { after: table.after } : {}),
          },
        }),
      );
      const oldRows = more && current.result?.kind === "rows" ? current.result.rows : [];
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
    } catch (error) {
      updateTab(tabId, {
        loading: false,
        error: databaseErrorMessage(error),
        // Rows from the previous filter would read as the answer to the failed one.
        ...(more ? {} : { result: undefined }),
      });
    } finally {
      pending.current.delete(tabId);
    }
  };
  const openTable = (connection: DatabaseConnection, schema: string, object: string) => {
    setSelectedConnection(connection.id);
    const existing = registry
      .get(workspaceAtom)
      .tabs.find(
        (item) =>
          item.connectionId === connection.id &&
          item.table?.schema === schema &&
          item.table.object === object,
      );
    if ((panel.current?.clientWidth ?? 0) < 760) setExplorerOpen(false);
    databasePanelIntent.consume(threadRef);
    if (existing) {
      registry.set(workspaceAtom, { ...registry.get(workspaceAtom), activeId: existing.id });
      return;
    }
    const next: DatabaseWorkspaceTab = {
      id: randomUUID(),
      connectionId: connection.id,
      title: `${schema}.${object}`,
      sql: "",
      loading: false,
      table: { schema, object, where: "", orderBy: "", offset: 0, after: null },
    };
    addTab(next);
    void loadTable(next.id);
    void databaseState.introspect.run(registry, {
      environmentId,
      input: { projectId, connectionId: connection.id, scope: { kind: "columns", schema, object } },
    });
  };
  const run = async (statements: SqlStatement[]) => {
    if (
      !tab ||
      !tabConnection ||
      tab.table ||
      tab.loading ||
      pending.current.has(tab.id) ||
      !statements.length ||
      !allowed
    )
      return;
    const risky = tabConnection.readOnly
      ? undefined
      : statements
          .map((statement) => ({
            statement: statement.text,
            risk: sqlWriteRisk(statement.text, tabConnection.target.engine),
          }))
          .find((item) => item.risk !== null);
    if (risky) {
      const statement =
        risky.statement.length > 300 ? `${risky.statement.slice(0, 300)}…` : risky.statement;
      const confirmed = await ensureLocalApi().dialogs.confirm(
        [
          `Run this on ${tabConnection.name}?`,
          risky.risk === "drop"
            ? "It drops or truncates data."
            : "It runs UPDATE or DELETE without a WHERE clause, so it changes every row.",
          "",
          statement,
        ].join("\n"),
        { variant: "destructive" },
      );
      if (!confirmed) return;
    }
    pending.current.add(tab.id);
    updateTab(tab.id, { loading: true, error: undefined, errorAt: undefined, progress: undefined });
    try {
      if (tab.queryId)
        databaseValue(
          await databaseState.closeQuery.run(registry, {
            environmentId,
            input: { projectId, queryId: tab.queryId },
          }),
        );
      let sessionId = await ensureSession(tab.id, tabConnection);
      for (const [index, statement] of statements.entries()) {
        if (!activeTab(tab.id)) break;
        const queryId = DatabaseQueryId.make(randomUUID());
        updateTab(tab.id, {
          queryId,
          progress: statements.length > 1 ? { index, total: statements.length } : undefined,
        });
        const execute = async () =>
          databaseValue(
            await databaseState.execute.run(registry, {
              environmentId,
              input: {
                projectId,
                sessionId,
                connectionId: tabConnection.id,
                queryId,
                sql: statement.text,
              },
            }),
          );
        let result;
        try {
          result = await execute();
        } catch (error) {
          if (
            typeof error !== "object" ||
            error === null ||
            !("failure" in error) ||
            error.failure !== "session-not-found"
          )
            throw error;
          // Expiry or connection edits can close an idle session before the client knows.
          updateTab(tab.id, { sessionId: undefined });
          sessionId = await ensureSession(tab.id, tabConnection);
          result = await execute();
        }
        if (!activeTab(tab.id)) {
          void releaseDatabaseResources(
            databaseState,
            registry,
            { environmentId, projectId },
            { queryId, sessionId },
          );
          break;
        }
        updateTab(tab.id, { result });
        if (result.kind === "failed") {
          if (result.position) updateTab(tab.id, { errorAt: statement.from + result.position - 1 });
          if (result.cancelled && tabConnection.target.engine === "sqlite")
            updateTab(tab.id, { sessionId: undefined });
          break;
        }
        if (index < statements.length - 1)
          databaseValue(
            await databaseState.closeQuery.run(registry, {
              environmentId,
              input: { projectId, queryId },
            }),
          );
      }
    } catch (error) {
      updateTab(tab.id, {
        error: databaseErrorMessage(error),
        ...(typeof error === "object" &&
        error !== null &&
        "failure" in error &&
        error.failure === "session-not-found"
          ? { sessionId: undefined }
          : {}),
      });
    } finally {
      pending.current.delete(tab.id);
      updateTab(tab.id, { loading: false });
    }
  };
  const cancel = () => {
    if (tab?.queryId && tab.loading) {
      if (paging.current.has(tab.id)) {
        updateTab(tab.id, { sessionId: undefined, queryId: undefined });
        void releaseDatabaseResources(databaseState, registry, { environmentId, projectId }, tab);
        return;
      }
      void databaseState.cancelQuery.run(registry, {
        environmentId,
        input: { projectId, queryId: tab.queryId },
      });
    }
  };
  const more = async () => {
    if (!tab || tab.loading || tab.result?.kind !== "rows" || !tab.result.hasMore) return;
    if (tab.table) {
      await loadTable(tab.id, true);
      return;
    }
    if (!tab.queryId || pending.current.has(tab.id)) return;
    pending.current.add(tab.id);
    paging.current.add(tab.id);
    updateTab(tab.id, { loading: true });
    try {
      const result = databaseValue(
        await databaseState.fetchPage.run(registry, {
          environmentId,
          input: { projectId, queryId: tab.queryId },
        }),
      );
      if (activeTab(tab.id)?.queryId !== tab.queryId) throw new Error("Query cancelled.");
      updateTab(tab.id, {
        result: {
          ...tab.result,
          rows: [...tab.result.rows, ...result.rows],
          hasMore: result.hasMore,
        },
        loading: false,
      });
    } catch (error) {
      const cancelled = activeTab(tab.id)?.queryId === undefined;
      const sessionLost =
        cancelled ||
        (typeof error === "object" &&
          error !== null &&
          "failure" in error &&
          error.failure === "engine-failed");
      if (sessionLost)
        void releaseDatabaseResources(databaseState, registry, { environmentId, projectId }, tab);
      updateTab(tab.id, {
        loading: false,
        ...(sessionLost ? { sessionId: undefined, queryId: undefined } : {}),
        result: { ...tab.result, hasMore: false },
        error: cancelled
          ? "Query cancelled. Run again to start a new session."
          : databaseErrorMessage(error),
      });
    } finally {
      pending.current.delete(tab.id);
      paging.current.delete(tab.id);
    }
  };
  const closeTab = async (tab: DatabaseWorkspaceTab) => {
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
    const current = registry.get(workspaceAtom);
    const tabs = current.tabs.filter((item) => item.id !== tab.id);
    registry.set(workspaceAtom, {
      tabs,
      activeId: current.activeId === tab.id ? (tabs.at(-1)?.id ?? null) : current.activeId,
    });
    void releaseDatabaseResources(databaseState, registry, { environmentId, projectId }, tab);
  };
  const intent = useDatabasePanelIntent((state) => state.byThread[key]);
  const handleIntent = useEffectEvent((intent: "query" | "table" | "explorer") => {
    databasePanelIntent.consume(threadRef);
    if (intent === "query" && selected) void newQuery(selected);
  });
  const reloadTable = useEffectEvent((id: string) => void loadTable(id));
  const restoredTable =
    allowed && !loading && tab?.table && !tab.result && !tab.loading && !tab.error ? tab.id : null;
  useEffect(() => {
    if (restoredTable) reloadTable(restoredTable);
  }, [restoredTable]);
  const showExplorer =
    (explorerOpen ?? (!compact || !tab)) || intent === "table" || intent === "explorer";
  const readyForQuery = selected !== undefined;
  useEffect(() => {
    if (intent === "query" && readyForQuery) handleIntent(intent);
  }, [intent, readyForQuery]);
  const columnInput = tab?.table
    ? {
        projectId,
        connectionId: tab.connectionId,
        scope: { kind: "columns" as const, schema: tab.table.schema, object: tab.table.object },
        revision: registry.get(databaseState.revision(environmentId)),
      }
    : {};
  const columnMetadata = useAtomValue(
    databaseState.metadata(databaseCacheKey(environmentId, columnInput)),
  );
  const filePath = tab?.filePath ?? "query.sql";
  const queryFile = async (save: boolean) => {
    if (!tab) return;
    setNotice(null);
    const confirm = (message: string) =>
      ensureLocalApi().dialogs.confirm(message, { variant: "destructive" });
    try {
      if (save) {
        const existing = await probeFile({
          environmentId,
          input: { cwd: workspaceRoot, relativePath: filePath },
        })
          .then((result) => databaseValue(result).contents)
          .catch(() => null);
        if (
          existing !== null &&
          existing !== tab.sql &&
          existing !== tab.savedSql &&
          !(await confirm(
            `Overwrite ${filePath}?\nThe file has contents this console did not write.`,
          ))
        )
          return;
        databaseValue(
          await projectEnvironment.writeFile.run(registry, {
            environmentId,
            input: { cwd: workspaceRoot, relativePath: filePath, contents: tab.sql },
          }),
        );
        updateTab(tab.id, { savedSql: tab.sql });
      } else {
        if (
          tab.sql.trim() &&
          tab.sql !== tab.savedSql &&
          !(await confirm(
            `Replace ${tab.title} with ${filePath}?\nThe console's unsaved SQL is discarded.`,
          ))
        )
          return;
        const result = databaseValue(
          await readFile({ environmentId, input: { cwd: workspaceRoot, relativePath: filePath } }),
        );
        if (result.truncated) throw new Error("This SQL file is too large to open in the editor.");
        updateTab(tab.id, { sql: result.contents, savedSql: result.contents });
      }
      setNotice(save ? `Saved ${filePath}` : `Opened ${filePath}`);
    } catch (error) {
      setNotice(databaseErrorMessage(error));
    }
  };

  const onLoadMore = useStableCallback(() => {
    void more();
  });
  const onOpenTable = useStableCallback(openTable);
  const refresh = () => {
    registry.set(
      databaseState.revision(environmentId),
      registry.get(databaseState.revision(environmentId)) + 1,
    );
  };
  const onNewQuery = useStableCallback((connection: DatabaseConnection) => {
    setSelectedConnection(connection.id);
    void newQuery(connection);
  });
  const onOrderBy = useStableCallback((orderBy: string) => {
    if (!tab?.table || tab.loading) return;
    updateTab(tab.id, { table: { ...tab.table, orderBy } });
    void loadTable(tab.id);
  });
  const result = tab && (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {!tab.table && (
        <div className="flex h-8 shrink-0 items-center gap-2 border-b bg-muted/30 px-3 text-xs">
          <Table2Icon className="size-3.5 text-muted-foreground" />
          <span className="font-medium">Result</span>
          <span className="ml-auto text-2xs text-muted-foreground" role="status">
            {tab.loading
              ? tab.progress
                ? `Running statement ${tab.progress.index + 1} of ${tab.progress.total}…`
                : "Running…"
              : tab.result
                ? `${tab.result.durationMs} ms`
                : "Ready"}
          </span>
        </div>
      )}
      {tab.error && (
        <p
          role="alert"
          className="break-words border-b bg-destructive/5 p-3 font-mono text-xs text-destructive-foreground"
        >
          {tab.error}
        </p>
      )}
      {tab.result?.kind === "failed" ? (
        <div role="alert" className="overflow-auto p-4 font-mono text-xs">
          {tab.progress && (
            <p className="mb-2 text-muted-foreground">
              Statement {tab.progress.index + 1} of {tab.progress.total}{" "}
              {tab.result.cancelled ? "was cancelled" : "failed"}. Earlier statements ran.
            </p>
          )}
          <p
            className={
              tab.result.cancelled
                ? "whitespace-pre-wrap text-muted-foreground"
                : "whitespace-pre-wrap text-destructive-foreground"
            }
          >
            {tab.result.cancelled ? "Query cancelled." : tab.result.message}
          </p>
          {tab.result.cancelled && tabConnection?.target.engine === "sqlite" && (
            <p className="mt-2 text-muted-foreground">
              SQLite session reset. Run again to start a new session.
            </p>
          )}
          {(tab.result.code || tab.errorAt !== undefined) && (
            <p className="mt-2 text-muted-foreground">
              {[tab.result.code, tab.errorAt !== undefined && sqlLocation(tab.sql, tab.errorAt)]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}
        </div>
      ) : tab.result?.kind === "command" ? (
        <div className="p-4 font-mono text-xs">
          <p>{tab.result.command} completed</p>
          {tab.result.affectedRows !== null && (
            <p className="mt-1 text-muted-foreground">{tab.result.affectedRows} affected rows</p>
          )}
        </div>
      ) : tab.result?.kind === "rows" ? (
        <DatabaseGrid
          key={`${tab.id}:${tab.queryId ?? "table"}`}
          columns={tab.result.columns}
          rows={tab.result.rows}
          {...(columnMetadata?.kind === "columns" ? { columnInfo: columnMetadata.columns } : {})}
          hasMore={tab.result.hasMore}
          expires={!tab.table}
          loading={tab.loading}
          onLoadMore={onLoadMore}
          {...(tab.table ? { orderBy: tab.table.orderBy, onOrderBy } : {})}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center px-6 text-xs text-muted-foreground">
          {tab.loading
            ? tab.table
              ? "Loading rows…"
              : "Executing query…"
            : tab.table
              ? "Fix the filter and apply it again."
              : "Run a query to see results here."}
        </div>
      )}
    </div>
  );
  const editor = tab && !tab.table && (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        className="flex h-9 shrink-0 items-center gap-1 border-b px-2"
        role="toolbar"
        aria-label="SQL actions"
      >
        <Button
          size="xs"
          variant="ghost"
          disabled={tab.loading || !tab.sql.trim()}
          onClick={() => sqlEditor.current?.run()}
          aria-description="Run statement or selection (Ctrl/⌘ Enter)"
        >
          <PlayIcon className="text-success" />
          Run
        </Button>
        <Menu>
          <MenuTrigger render={<Button size="icon-xs" variant="ghost" aria-label="Run options" />}>
            <ChevronDownIcon />
          </MenuTrigger>
          <MenuPopup align="start">
            <MenuItem
              disabled={tab.loading || !tab.sql.trim()}
              onClick={() =>
                void run(sqlStatementRanges(tab.sql, tabConnection?.target.engine ?? "postgres"))
              }
            >
              Run entire script
            </MenuItem>
          </MenuPopup>
        </Menu>
        <DatabaseToolbarButton
          label="Cancel query (Escape)"
          disabled={!tab.loading}
          onClick={cancel}
        >
          <SquareIcon />
        </DatabaseToolbarButton>
        <span className="mx-1 h-4 border-l" />
        <DatabaseToolbarButton
          label="SQL files"
          onClick={() => setFilesOpen(!filesOpen)}
          aria-pressed={filesOpen}
        >
          <FolderOpenIcon />
        </DatabaseToolbarButton>
        <span
          className="ml-auto truncate text-2xs text-muted-foreground"
          aria-description={tabConnection?.name}
        >
          {tabConnection?.target.engine === "sqlite" ? "SQLite" : "PostgreSQL"} ·{" "}
          {tabConnection?.name}
          {tabConnection?.readOnly ? " · Read-only" : ""}
        </span>
      </div>
      {filesOpen && (
        <div className="flex shrink-0 items-center gap-1 border-b bg-muted/20 p-1.5">
          <div className="min-w-0 flex-1">
            <Input
              size="compact"
              font="mono"
              aria-label="Query file path"
              value={filePath}
              onChange={(event) => updateTab(tab.id, { filePath: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") void queryFile(false);
              }}
            />
          </div>
          <DatabaseToolbarButton label="Open SQL" onClick={() => void queryFile(false)}>
            <FolderOpenIcon />
          </DatabaseToolbarButton>
          <DatabaseToolbarButton label="Save SQL" onClick={() => void queryFile(true)}>
            <SaveIcon />
          </DatabaseToolbarButton>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        <DatabaseSqlEditor
          ref={sqlEditor}
          key={tab.id}
          value={tab.sql}
          engine={tabConnection?.target.engine ?? "postgres"}
          completionSource={completion}
          errorAt={tab.errorAt}
          onChange={(sql) => updateTab(tab.id, { sql })}
          onRun={(statements) => void run(statements)}
          onCancel={cancel}
        />
      </div>
    </div>
  );
  const content = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {workspace.tabs.length > 0 && (
        <div
          className="relative flex h-8 shrink-0 overflow-x-auto bg-muted/20 before:absolute before:inset-x-0 before:bottom-0 before:h-px before:bg-border"
          role="tablist"
          aria-label="Database tabs"
        >
          {workspace.tabs.map((item) => (
            <div
              key={item.id}
              className={`group relative flex shrink-0 items-center border-r pl-2 pr-1 ${item.id === workspace.activeId ? "bg-background after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-primary" : "text-muted-foreground"}`}
            >
              <button
                role="tab"
                aria-selected={item.id === workspace.activeId}
                aria-description={`${item.title} · ${connections.find((connection) => connection.id === item.connectionId)?.name ?? ""}`}
                className="flex h-full max-w-48 items-center gap-1.5 px-1.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                onClick={() => {
                  setSelectedConnection(item.connectionId);
                  registry.set(workspaceAtom, { ...workspace, activeId: item.id });
                }}
              >
                {item.table ? (
                  <Table2Icon className="size-3.5 shrink-0" />
                ) : (
                  <SquareTerminalIcon className="size-3.5 shrink-0" />
                )}
                <span className="truncate">{item.title}</span>
              </button>
              <DatabaseToolbarButton
                label={`Close ${item.title}`}
                onClick={() => void closeTab(item)}
              >
                <XIcon />
              </DatabaseToolbarButton>
            </div>
          ))}
        </div>
      )}
      {!tab ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
          <DatabaseIcon className="size-8 text-muted-foreground/40" />
          <div>
            <h3 className="text-sm font-medium">Database workspace</h3>
            <p className="mt-1 max-w-64 text-xs leading-relaxed text-muted-foreground">
              Double-click a table to view data, or open a console to write SQL.
            </p>
          </div>
          <Button
            size="xs"
            variant="outline"
            disabled={!selected || !allowed}
            onClick={() => selected && void newQuery(selected)}
          >
            <SquareTerminalIcon />
            New query console
          </Button>
        </div>
      ) : tab.table ? (
        <>
          <div
            className="flex h-8 shrink-0 items-center gap-1 border-b px-2"
            role="toolbar"
            aria-label="Table actions"
          >
            <DatabaseToolbarButton
              label="Refresh table"
              disabled={tab.loading}
              onClick={() => void loadTable(tab.id)}
            >
              <RefreshCwIcon />
            </DatabaseToolbarButton>
            <span className="truncate text-2xs text-muted-foreground">
              {tabConnection?.name} / {tab.table.schema}
            </span>
          </div>
          <form
            className="flex shrink-0 items-center gap-1 border-b px-2 py-1"
            onSubmit={(event) => {
              event.preventDefault();
              void loadTable(tab.id);
            }}
          >
            <div className="min-w-0 flex-1">
              <Input
                size="compact"
                unstyled
                font="mono"
                aria-label="WHERE filter"
                placeholder="WHERE condition"
                value={tab.table.where}
                onChange={(event) =>
                  updateTab(tab.id, { table: { ...tab.table!, where: event.target.value } })
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
                  updateTab(tab.id, { table: { ...tab.table!, orderBy: event.target.value } })
                }
              />
            </div>
            <DatabaseToolbarButton label="Apply filter" type="submit" disabled={tab.loading}>
              <PlayIcon />
            </DatabaseToolbarButton>
          </form>
          {result}
        </>
      ) : (
        <DatabaseSplit
          key={tab.id}
          direction="vertical"
          label="Resize SQL editor and results"
          first={editor}
          second={result}
          initial={52}
        />
      )}
      {notice && (
        <p role="status" className="shrink-0 border-t px-3 py-1 text-xs text-muted-foreground">
          {notice}
        </p>
      )}
    </div>
  );
  const explorer = (
    <aside className="flex min-h-0 min-w-0 flex-1 flex-col bg-muted/15" aria-label="Data sources">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b px-2">
        <span className="mr-auto text-xs font-medium">Database</span>
        <DatabaseToolbarButton
          label="New database connection"
          disabled={!canSave}
          onClick={() => setEditing("new")}
        >
          <PlusIcon />
        </DatabaseToolbarButton>
        <DatabaseToolbarButton label="Refresh schema" onClick={refresh}>
          <RefreshCwIcon />
        </DatabaseToolbarButton>
      </div>
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
        <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <Input
          size="compact"
          unstyled
          aria-label="Find database table"
          placeholder="Find table…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>
      <DatabaseExplorer
        {...{ connections, environmentId, projectId, filter }}
        onTable={onOpenTable}
        onQuery={onNewQuery}
        onEdit={setEditing}
      />
    </aside>
  );
  return (
    <div ref={panel} className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b bg-muted/20 px-2">
        <Menu>
          <MenuTrigger
            render={<Button size="xs" variant="ghost" aria-label="Select data source" />}
          >
            <DatabaseIcon />
            <span className="max-w-48 truncate">{selected?.name ?? "Data source"}</span>
            <ChevronDownIcon />
          </MenuTrigger>
          <MenuPopup align="start">
            {connections.map((connection) => (
              <MenuItem key={connection.id} onClick={() => setSelectedConnection(connection.id)}>
                <DatabaseIcon />
                {connection.name}
                <span className="ml-auto text-xs text-muted-foreground">{connection.level}</span>
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem disabled={!canSave} onClick={() => setEditing("new")}>
              <PlusIcon />
              New data source
            </MenuItem>
          </MenuPopup>
        </Menu>
        <DatabaseToolbarButton
          label="New query console"
          disabled={!selected || !allowed}
          onClick={() => selected && void newQuery(selected)}
        >
          <SquareTerminalIcon />
        </DatabaseToolbarButton>
        <DatabaseToolbarButton
          label="Connection properties"
          disabled={!selected || !canSave}
          onClick={() => selected && setEditing(selected)}
        >
          <Settings2Icon />
        </DatabaseToolbarButton>
        <div className="ml-auto">
          <DatabaseToolbarButton
            label={showExplorer ? "Hide database explorer" : "Show database explorer"}
            aria-pressed={showExplorer}
            onClick={() => {
              databasePanelIntent.consume(threadRef);
              setExplorerOpen(!showExplorer);
            }}
          >
            <PanelRightIcon />
          </DatabaseToolbarButton>
        </div>
      </div>
      {!allowed ? (
        <p className="p-3 text-sm">Database access requires terminal permission.</p>
      ) : (
        <>
          {(error || loading) && (
            <p role="status" className="p-2 text-xs">
              {error ?? "Loading connections…"}
            </p>
          )}
          <DatabaseSplit
            direction="horizontal"
            label="Resize database explorer"
            first={content}
            second={explorer}
            initial={72}
            collapsed={!showExplorer}
          />
        </>
      )}
      {editing && (
        <DatabaseConnectionDialog
          environmentId={environmentId}
          projectId={projectId}
          {...(editing === "new" ? {} : { connection: editing })}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
