import { useStableCallback } from "../../hooks/useStableCallback";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
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
import { useContext, useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { databaseState } from "../../state/database";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { projectEnvironment } from "../../state/projects";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { useRightPanelStore } from "../../rightPanelStore";
import { useTerminalUiStateStore } from "../../terminalUiStateStore";
import { randomUUID } from "../../lib/utils";
import { observeResize } from "../../lib/observeResize";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { DatabaseConnectionDialog } from "./DatabaseConnectionDialog";
import { DatabaseExplorer } from "./DatabaseExplorer";
import { DatabaseGrid } from "./DatabaseGrid";
import { DatabaseSqlEditor, type DatabaseSqlEditorHandle } from "./DatabaseSqlEditor";
import { DatabaseSplit } from "./DatabaseSplit";
import { DatabaseHint, DatabaseToolbarButton } from "./DatabaseToolbarButton";
import { Kbd } from "../ui/kbd";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuShortcut } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { formatShortcutLabel } from "../../keybindings";
import {
  ChevronDownIcon,
  DatabaseIcon,
  FileCodeIcon,
  FolderOpenIcon,
  PanelRightIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  SearchIcon,
  SquareIcon,
  SquareTerminalIcon,
  XIcon,
} from "lucide-react";
import { databaseErrorMessage, databaseValue, useDatabaseConnections } from "./databaseHooks";
import { databasePanelIntent, useDatabasePanelIntent } from "./databasePanelIntent";
import { sqlStatementRanges, sqlWriteRisk, type SqlStatement } from "./sqlStatements";
import { ensureLocalApi } from "../../localApi";
import { createSqlSchemaCompletion } from "./sqlCompletion";
import { persistDatabaseWorkspace } from "./databaseConsoleStorage";
import { showDatabaseDrawerTable } from "./databaseDrawerStore";

const shortcut = (shiftKey: boolean) =>
  formatShortcutLabel({
    key: "enter",
    modKey: true,
    shiftKey,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
  });
const RUN_SHORTCUT = shortcut(false);
const RUN_ALL_SHORTCUT = shortcut(true);

const sqlLocation = (sql: string, offset: number) => {
  const before = sql.slice(0, offset).split("\n");
  return `Line ${before.length}, column ${(before.at(-1)?.length ?? 0) + 1}`;
};

const owners = new Map<string, () => void>();
// Closing the panel keeps tabs, so in-flight work checks this token instead of tab existence.
const ownership = new Map<string, object>();
const ownershipToken = (key: string) => {
  const token = ownership.get(key) ?? {};
  ownership.set(key, token);
  return token;
};
useRightPanelStore.subscribe((state, previous) => {
  for (const [key, release] of owners) {
    if (
      previous.byThreadKey[key]?.surfaces.some((surface) => surface.kind === "database") &&
      !state.byThreadKey[key]?.surfaces.some((surface) => surface.kind === "database")
    ) {
      ownership.delete(key);
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
  // Table tabs share the workspace but open in the bottom drawer.
  const consoles = workspace.tabs.filter((item) => !item.table);
  const tab = consoles.find((item) => item.id === workspace.activeId);
  const tabConnection = connections.find((item) => item.id === tab?.connectionId);
  const selected = tabConnection ?? connections[0];
  const findTable = useRef<HTMLInputElement>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const panelId = useId();
  const revision = useAtomValue(databaseState.revision(environmentId));
  // Statements can change search_path; their outcomes invalidate the completion source's cache.
  const completionContext = (() => ({
    sessionId: tab?.sessionId,
    result: tab?.result,
    revision,
  }))();
  const completion = (() => {
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
  })();
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
  const isLive = (token: object, id: string) =>
    ownership.get(key) === token && activeTab(id) !== undefined;
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
      tabs: current.tabs.map((tab) => {
        if (tab.table) return tab;
        const {
          sessionId: _session,
          queryId: _query,
          result: _result,
          error: _error,
          ...rest
        } = tab;
        return { ...rest, loading: false };
      }),
    });
  });
  useEffect(() => {
    owners.set(key, () => releaseOwner());
  }, [key]);
  useEffect(() => {
    persistDatabaseWorkspace(key, registry.get(workspaceAtom));
    return registry.subscribe(workspaceAtom, (next) => persistDatabaseWorkspace(key, next));
  }, [key, registry, workspaceAtom]);
  const ensureSession = async (
    tabId: string,
    connection: DatabaseConnection,
    token = ownershipToken(key),
  ) => {
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
    if (!isLive(token, tabId)) {
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
    const token = ownershipToken(key);
    return await (async () => {
      await ensureSession(next.id, connection, token);
      updateTab(next.id, { loading: false });
    })().catch(async (error: unknown) => {
      if (!isLive(token, next.id)) return;
      updateTab(next.id, {
        loading: false,
        error: databaseErrorMessage(error),
        sessionId: undefined,
      });
    });
  };
  const openTable = (connection: DatabaseConnection, schema: string, object: string) => {
    databasePanelIntent.consume(threadRef);
    const current = registry.get(workspaceAtom);
    const existing = current.tabs.find(
      (item) =>
        item.connectionId === connection.id &&
        item.table?.schema === schema &&
        item.table.object === object,
    );
    const id = existing?.id ?? randomUUID();
    if (!existing) {
      registry.set(workspaceAtom, {
        ...current,
        tabs: [
          ...current.tabs,
          {
            id,
            connectionId: connection.id,
            title: `${schema}.${object}`,
            sql: "",
            loading: false,
            table: { schema, object, where: "", orderBy: "", offset: 0, after: null },
          },
        ],
      });
      void databaseState.introspect.run(registry, {
        environmentId,
        input: {
          projectId,
          connectionId: connection.id,
          scope: { kind: "columns", schema, object },
        },
      });
    }
    showDatabaseDrawerTable(key, id);
    useTerminalUiStateStore.getState().setTerminalOpen(threadRef, true);
  };
  const run = async (statements: SqlStatement[]) => {
    if (
      !tab ||
      !tabConnection ||
      tab.loading ||
      pending.current.has(tab.id) ||
      !statements.length ||
      !allowed
    )
      return;
    const token = ownershipToken(key);
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
      if (!confirmed || !isLive(token, tab.id)) return;
    }
    pending.current.add(tab.id);
    updateTab(tab.id, { loading: true, error: undefined, errorAt: undefined, progress: undefined });
    return await (async () => {
      if (tab.queryId)
        databaseValue(
          await databaseState.closeQuery.run(registry, {
            environmentId,
            input: { projectId, queryId: tab.queryId },
          }),
        );
      if (!isLive(token, tab.id)) return;
      let sessionId = await ensureSession(tab.id, tabConnection, token);
      for (const [index, statement] of statements.entries()) {
        if (!isLive(token, tab.id)) break;
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
        const result = await execute().catch(async (error: unknown) => {
          if (
            typeof error !== "object" ||
            error === null ||
            !("failure" in error) ||
            error.failure !== "session-not-found"
          )
            throw error;
          if (!isLive(token, tab.id)) throw error;
          // Expiry or connection edits can close an idle session before the client knows.
          updateTab(tab.id, { sessionId: undefined });
          sessionId = await ensureSession(tab.id, tabConnection, token);
          return execute();
        });
        if (!isLive(token, tab.id)) {
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
    })()
      .catch(async (error: unknown) => {
        if (!isLive(token, tab.id)) return;
        updateTab(tab.id, {
          error: databaseErrorMessage(error),
          ...(typeof error === "object" &&
          error !== null &&
          "failure" in error &&
          error.failure === "session-not-found"
            ? { sessionId: undefined }
            : {}),
        });
      })
      .finally(() => {
        pending.current.delete(tab.id);
        if (isLive(token, tab.id)) updateTab(tab.id, { loading: false });
      });
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
    if (!tab.queryId || pending.current.has(tab.id)) return;
    const token = ownershipToken(key);
    pending.current.add(tab.id);
    paging.current.add(tab.id);
    updateTab(tab.id, { loading: true });
    const queryId = tab.queryId;
    const previousResult = tab.result;
    return await (async () => {
      const result = databaseValue(
        await databaseState.fetchPage.run(registry, {
          environmentId,
          input: { projectId, queryId },
        }),
      );
      if (!isLive(token, tab.id)) return;
      if (activeTab(tab.id)?.queryId !== tab.queryId) throw new Error("Query cancelled.");
      updateTab(tab.id, {
        result: {
          ...previousResult,
          rows: [...previousResult.rows, ...result.rows],
          hasMore: result.hasMore,
        },
        loading: false,
      });
    })()
      .catch(async (error: unknown) => {
        // Closing the panel already released this query's resources.
        if (!isLive(token, tab.id)) return;
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
          result: { ...previousResult, hasMore: false },
          error: cancelled
            ? "Query cancelled. Run again to start a new session."
            : databaseErrorMessage(error),
        });
      })
      .finally(() => {
        pending.current.delete(tab.id);
        paging.current.delete(tab.id);
      });
  };
  const closeTab = async (tab: DatabaseWorkspaceTab) => {
    if (
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
      activeId:
        current.activeId === tab.id
          ? (tabs.findLast((item) => !item.table)?.id ?? null)
          : current.activeId,
    });
    void releaseDatabaseResources(databaseState, registry, { environmentId, projectId }, tab);
  };
  const intent = useDatabasePanelIntent((state) => state.byThread[key]);
  const handleIntent = useEffectEvent((intent: "query" | "table" | "explorer") => {
    databasePanelIntent.consume(threadRef);
    if (intent === "query" && selected) void newQuery(selected);
  });
  const showExplorer =
    (explorerOpen ?? (!compact || !tab)) || intent === "table" || intent === "explorer";
  const readyForQuery = selected !== undefined;
  useEffect(() => {
    if (intent === "query" && readyForQuery) handleIntent(intent);
  }, [intent, readyForQuery]);
  const filePath = tab?.filePath ?? "query.sql";
  const queryFile = async (save: boolean) => {
    if (!tab) return;
    setNotice(null);
    const confirm = (message: string) =>
      ensureLocalApi().dialogs.confirm(message, { variant: "destructive" });
    return await (async () => {
      if (save) {
        const probe = await probeFile({
          environmentId,
          input: { cwd: workspaceRoot, relativePath: filePath },
        });
        // The server cannot tell a missing file from an unreadable one, so any failure asks.
        const question = !AsyncResult.isSuccess(probe)
          ? `Save to ${filePath}?\nIt does not exist yet, or could not be read: ${databaseErrorMessage(squashAtomCommandFailure(probe))}`
          : probe.value.truncated
            ? `Overwrite ${filePath}?\nThe file is too large to compare with this console.`
            : probe.value.contents !== tab.sql && probe.value.contents !== tab.savedSql
              ? `Overwrite ${filePath}?\nThe file has contents this console did not write.`
              : null;
        if (question && !(await confirm(question))) return;
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
    })().catch(async (error: unknown) => {
      setNotice(databaseErrorMessage(error));
    });
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
    void newQuery(connection);
  });
  const switchConnection = (connection: DatabaseConnection) => {
    if (!tab || tab.loading || tab.connectionId === connection.id) return;
    void releaseDatabaseResources(databaseState, registry, { environmentId, projectId }, tab);
    updateTab(tab.id, {
      connectionId: connection.id,
      sessionId: undefined,
      queryId: undefined,
      result: undefined,
      error: undefined,
      errorAt: undefined,
      progress: undefined,
    });
  };
  const activate = (id: string) => {
    registry.set(workspaceAtom, { ...registry.get(workspaceAtom), activeId: id });
  };
  useEffect(() => {
    if (intent === "table") findTable.current?.focus();
  }, [intent]);
  const status = tab?.loading
    ? tab.progress
      ? `Running ${tab.progress.index + 1} of ${tab.progress.total}`
      : "Running"
    : null;
  const result = tab && (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
        <div className="p-4 font-mono text-xs" role="status">
          <p>{tab.result.command} completed</p>
          <p className="mt-1 text-muted-foreground">
            {tab.result.affectedRows !== null
              ? `${tab.result.affectedRows.toLocaleString()} ${tab.result.affectedRows === 1 ? "row" : "rows"} affected · `
              : ""}
            {tab.result.durationMs} ms
          </p>
        </div>
      ) : tab.result?.kind === "rows" ? (
        <DatabaseGrid
          key={`${tab.id}:${tab.queryId ?? ""}`}
          columns={tab.result.columns}
          rows={tab.result.rows}
          hasMore={tab.result.hasMore}
          expires
          durationMs={tab.result.durationMs}
          exportName={tab.title}
          loading={tab.loading}
          onLoadMore={onLoadMore}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center gap-2 px-6 text-xs text-muted-foreground">
          {tab.loading && <Spinner size="sm" tone="muted" />}
          {tab.loading ? "Executing query…" : "Run a query to see results here."}
        </div>
      )}
    </div>
  );
  const editor = tab && (
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
          aria-keyshortcuts="Control+Enter Meta+Enter"
        >
          {tab.loading ? <Spinner /> : <PlayIcon className="text-success" />}
          {status ?? "Run"}
          {!tab.loading && <Kbd>{RUN_SHORTCUT}</Kbd>}
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
              <MenuShortcut>{RUN_ALL_SHORTCUT}</MenuShortcut>
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
          label={filesOpen ? "Hide SQL file" : "Open or save a SQL file"}
          onClick={() => setFilesOpen(!filesOpen)}
          aria-pressed={filesOpen}
        >
          <FileCodeIcon />
        </DatabaseToolbarButton>
        <Menu>
          <MenuTrigger
            disabled={tab.loading}
            render={
              <Button
                size="xs"
                variant="ghost"
                className="ml-auto min-w-0"
                aria-label={`Connection: ${tabConnection?.name ?? "unavailable"}. Change connection`}
              />
            }
          >
            <DatabaseIcon />
            <span className="truncate">
              {tabConnection
                ? `${tabConnection.name}${tabConnection.readOnly ? " · Read-only" : ""}`
                : "Connection unavailable"}
            </span>
            <ChevronDownIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            {connections.map((connection) => (
              <MenuItem key={connection.id} onClick={() => switchConnection(connection)}>
                <DatabaseIcon />
                {connection.name}
                <span className="ml-auto pl-4 text-xs text-muted-foreground">
                  {connection.target.engine === "sqlite" ? "SQLite" : "PostgreSQL"}
                  {connection.readOnly ? " · Read-only" : ""}
                </span>
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      </div>
      {filesOpen && (
        <div className="flex shrink-0 items-center gap-1 border-b bg-muted/20 p-1.5">
          <div className="min-w-0 flex-1">
            <Input
              size="compact"
              font="mono"
              aria-label="SQL file path, relative to the project"
              value={filePath}
              onChange={(event) => updateTab(tab.id, { filePath: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") void queryFile(false);
              }}
            />
          </div>
          <DatabaseToolbarButton
            label="Open file into this console"
            onClick={() => void queryFile(false)}
          >
            <FolderOpenIcon />
          </DatabaseToolbarButton>
          <DatabaseToolbarButton label="Save console to file" onClick={() => void queryFile(true)}>
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
          onChange={(sql) => updateTab(tab.id, { sql, errorAt: undefined })}
          onRun={(statements) => void run(statements)}
          onCancel={cancel}
        />
      </div>
    </div>
  );
  const focusTab = (id: string | undefined) => {
    if (!id) return;
    activate(id);
    tabRefs.current.get(id)?.focus();
  };
  const newConsole =
    connections.length > 1 ? (
      <Menu>
        <MenuTrigger
          disabled={!allowed}
          render={<DatabaseToolbarButton label="New query console" />}
        >
          <PlusIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          {connections.map((connection) => (
            <MenuItem key={connection.id} onClick={() => void newQuery(connection)}>
              <SquareTerminalIcon />
              {connection.name}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    ) : (
      <DatabaseToolbarButton
        label="New query console"
        disabled={!selected || !allowed}
        onClick={() => selected && void newQuery(selected)}
      >
        <PlusIcon />
      </DatabaseToolbarButton>
    );
  const content = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="relative flex h-8 shrink-0 bg-muted/20 before:absolute before:inset-x-0 before:bottom-0 before:h-px before:bg-border">
        <div
          className="flex min-w-0 flex-1 overflow-x-auto"
          role="tablist"
          aria-label="Database tabs"
          onKeyDown={(event) => {
            const index = consoles.findIndex((item) => item.id === workspace.activeId);
            const next =
              event.key === "ArrowRight"
                ? consoles[(index + 1) % consoles.length]
                : event.key === "ArrowLeft"
                  ? consoles.at(index - 1)
                  : event.key === "Home"
                    ? consoles[0]
                    : event.key === "End"
                      ? consoles.at(-1)
                      : undefined;
            if (!next) return;
            event.preventDefault();
            focusTab(next.id);
          }}
        >
          {consoles.map((item) => {
            const active = item.id === workspace.activeId;
            const connection = connections.find((entry) => entry.id === item.connectionId);
            return (
              <div
                key={item.id}
                className={`group relative flex shrink-0 items-center border-r pl-2 pr-1 ${active ? "bg-background after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-primary" : "text-muted-foreground"}`}
              >
                <DatabaseHint
                  label={`${item.title}${connection ? ` · ${connection.name}` : ""}${item.sql.trim() && item.sql !== item.savedSql ? " · Not saved to a file" : ""}`}
                >
                  <button
                    ref={(element) => {
                      if (element) tabRefs.current.set(item.id, element);
                      else tabRefs.current.delete(item.id);
                    }}
                    id={`${panelId}-tab-${item.id}`}
                    role="tab"
                    aria-selected={active}
                    aria-controls={`${panelId}-panel`}
                    tabIndex={active ? 0 : -1}
                    className="flex h-full max-w-48 items-center gap-1.5 px-1.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                    onClick={() => activate(item.id)}
                  >
                    <SquareTerminalIcon className="size-3.5 shrink-0" />
                    <span className="truncate">{item.title}</span>
                  </button>
                </DatabaseHint>
                <DatabaseToolbarButton
                  label={`Close ${item.title}`}
                  tabIndex={active ? 0 : -1}
                  onClick={() => void closeTab(item)}
                >
                  <XIcon />
                </DatabaseToolbarButton>
              </div>
            );
          })}
        </div>
        <div className="relative flex shrink-0 items-center gap-0.5 px-1">
          {newConsole}
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
      {!tab ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
          <DatabaseIcon className="size-8 text-muted-foreground/40" />
          <div>
            <h3 className="text-sm font-medium">Databases</h3>
            <p className="mt-1 max-w-64 text-xs leading-relaxed text-muted-foreground">
              {loading
                ? "Loading connections…"
                : connections.length
                  ? "Double-click a table to view its rows in the bottom panel, or open a console to write SQL."
                  : "Add a connection to a PostgreSQL or SQLite database to browse it here."}
            </p>
          </div>
          {!loading &&
            (connections.length ? (
              <Button
                size="xs"
                variant="outline"
                disabled={!selected || !allowed}
                onClick={() => selected && void newQuery(selected)}
              >
                <SquareTerminalIcon />
                New query console
              </Button>
            ) : (
              <Button
                size="xs"
                variant="outline"
                disabled={!canSave}
                onClick={() => setEditing("new")}
              >
                <PlusIcon />
                New connection
              </Button>
            ))}
        </div>
      ) : (
        <div
          id={`${panelId}-panel`}
          role="tabpanel"
          aria-labelledby={`${panelId}-tab-${tab.id}`}
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          <DatabaseSplit
            key={tab.id}
            direction="vertical"
            label="Resize SQL editor and results"
            first={editor}
            second={result}
            initial={52}
          />
        </div>
      )}
      {notice && (
        <p role="status" className="shrink-0 border-t px-3 py-1 text-xs text-muted-foreground">
          {notice}
        </p>
      )}
    </div>
  );
  const explorer = (
    <aside className="flex min-h-0 min-w-0 flex-1 flex-col bg-muted/15" aria-label="Connections">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b px-2">
        <h2 className="mr-auto text-xs font-medium">Connections</h2>
        <DatabaseToolbarButton
          label="New connection"
          disabled={!canSave}
          onClick={() => setEditing("new")}
        >
          <PlusIcon />
        </DatabaseToolbarButton>
        <DatabaseToolbarButton label="Refresh schemas" onClick={refresh}>
          <RefreshCwIcon />
        </DatabaseToolbarButton>
      </div>
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
        <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <Input
          ref={findTable}
          size="compact"
          unstyled
          aria-label="Find table in loaded connections"
          placeholder="Find table…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && filter) {
              event.stopPropagation();
              setFilter("");
            }
          }}
        />
      </div>
      <DatabaseExplorer
        {...{ connections, environmentId, projectId, filter, loading }}
        onTable={onOpenTable}
        onQuery={onNewQuery}
        onEdit={setEditing}
      />
    </aside>
  );
  return (
    <div ref={panel} className="flex h-full min-h-0 flex-col bg-background">
      {!allowed ? (
        <p className="p-3 text-sm">Database access requires terminal permission.</p>
      ) : (
        <>
          {error && (
            <p role="alert" className="border-b p-2 text-xs text-destructive-foreground">
              {error}
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
