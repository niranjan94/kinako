import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  releaseDatabaseResources,
  type DatabaseWorkspaceTab,
} from "@t3tools/client-runtime/state/database";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  DatabaseQueryId,
  type DatabaseConnection,
  type EnvironmentId,
  type ProjectId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import {
  ChevronDownIcon,
  DatabaseIcon,
  FileCodeIcon,
  FolderOpenIcon,
  PlayIcon,
  SaveIcon,
  SquareIcon,
} from "lucide-react";
import { useContext, useRef, useState } from "react";
import { useStableCallback } from "../../hooks/useStableCallback";
import { formatShortcutLabel } from "../../keybindings";
import { randomUUID } from "../../lib/utils";
import { ensureLocalApi } from "../../localApi";
import { databaseState } from "../../state/database";
import { projectEnvironment } from "../../state/projects";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { DatabaseGrid } from "./DatabaseGrid";
import { DatabaseSplit } from "./DatabaseSplit";
import { DatabaseSqlEditor, type DatabaseSqlEditorHandle } from "./DatabaseSqlEditor";
import { DatabaseToolbarButton } from "./DatabaseToolbarButton";
import { databaseErrorMessage, databaseValue, useDatabaseConnections } from "./databaseHooks";
import {
  ensureDatabaseSession,
  findDatabaseTab,
  updateDatabaseTab,
  type DatabaseWorkspaceScope,
} from "./databaseWorkspace";
import { createSqlSchemaCompletion } from "./sqlCompletion";
import { sqlStatementRanges, sqlWriteRisk, type SqlStatement } from "./sqlStatements";

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

// Work outlives the view when the drawer switches tabs, so these are keyed by tab id.
const pending = new Set<string>();
const paging = new Set<string>();

export function DatabaseConsoleView({
  environmentId,
  projectId,
  threadRef,
  tabId,
  workspaceRoot,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadRef: ScopedThreadRef;
  tabId: string;
  workspaceRoot: string;
}) {
  const tab = useAtomValue(databaseState.workspaces(scopedThreadKey(threadRef))).tabs.find(
    (item) => item.id === tabId,
  );
  if (!tab || tab.table) return null;
  return (
    <ConsoleView
      key={tab.id}
      environmentId={environmentId}
      projectId={projectId}
      threadRef={threadRef}
      tab={tab}
      workspaceRoot={workspaceRoot}
    />
  );
}

function ConsoleView({
  environmentId,
  projectId,
  threadRef,
  tab,
  workspaceRoot,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadRef: ScopedThreadRef;
  tab: DatabaseWorkspaceTab;
  workspaceRoot: string;
}) {
  const registry = useContext(RegistryContext);
  const scope: DatabaseWorkspaceScope = { registry, environmentId, projectId, threadRef };
  const { connections, allowed } = useDatabaseConnections(environmentId, projectId);
  const tabConnection = connections.find((item) => item.id === tab.connectionId);
  const sqlEditor = useRef<DatabaseSqlEditorHandle>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [databaseList, setDatabaseList] = useState<{
    connectionId: string;
    names: readonly string[];
  } | null>(null);
  const databaseName =
    tab.database ??
    (tabConnection?.target.engine === "postgres"
      ? tabConnection.target.databaseSelection && tabConnection.target.databaseSelection !== "all"
        ? tabConnection.target.databaseSelection[0]
        : tabConnection.target.database
      : undefined);
  const loadDatabases = async () => {
    if (!tabConnection) return;
    try {
      const result = databaseValue(
        await databaseState.introspect.run(registry, {
          environmentId,
          input: { projectId, connectionId: tabConnection.id, scope: { kind: "databases" } },
        }),
      );
      if (result.kind === "databases")
        setDatabaseList({
          connectionId: tabConnection.id,
          names: result.databases.map((item) => item.name),
        });
    } catch (error) {
      setNotice(databaseErrorMessage(error));
    }
  };
  const revision = useAtomValue(databaseState.revision(environmentId));
  const readFile = useAtomQueryRunner(projectEnvironment.readFile, { refresh: true });
  const probeFile = useAtomQueryRunner(projectEnvironment.readFile, {
    refresh: true,
    reportFailure: false,
  });
  const updateTab = (id: string, patch: Partial<DatabaseWorkspaceTab>) =>
    updateDatabaseTab(registry, threadRef, id, patch);
  const current = (id: string) => findDatabaseTab(registry, threadRef, id);
  const isLive = (id: string) => current(id) !== undefined;
  // Statements can change search_path; their outcomes invalidate the completion source's cache.
  const completionContext = (() => ({
    sessionId: tab.sessionId,
    result: tab.result,
    revision,
  }))();
  const completion = (() => {
    if (!tabConnection) return undefined;
    return createSqlSchemaCompletion(tabConnection.target.engine, async (scope) => {
      const input = {
        projectId,
        connectionId: tabConnection.id,
        ...(tab.database !== undefined ? { database: tab.database } : {}),
        scope,
        ...(completionContext.sessionId ? { sessionId: completionContext.sessionId } : {}),
      };
      return databaseValue(await databaseState.introspect.run(registry, { environmentId, input }));
    });
  })();
  const run = async (statements: SqlStatement[]) => {
    if (!tabConnection || tab.loading || pending.has(tab.id) || !statements.length || !allowed)
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
      if (!confirmed || !isLive(tab.id)) return;
    }
    pending.add(tab.id);
    updateTab(tab.id, { loading: true, error: undefined, errorAt: undefined, progress: undefined });
    return await (async () => {
      if (tab.queryId)
        databaseValue(
          await databaseState.closeQuery.run(registry, {
            environmentId,
            input: { projectId, queryId: tab.queryId },
          }),
        );
      if (!isLive(tab.id)) return;
      let sessionId = await ensureDatabaseSession(scope, tab.id, tabConnection);
      for (const [index, statement] of statements.entries()) {
        if (!isLive(tab.id)) break;
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
                ...(tab.database !== undefined ? { database: tab.database } : {}),
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
          if (!isLive(tab.id)) throw error;
          // Expiry or connection edits can close an idle session before the client knows.
          updateTab(tab.id, { sessionId: undefined });
          sessionId = await ensureDatabaseSession(scope, tab.id, tabConnection);
          return execute();
        });
        if (!isLive(tab.id)) {
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
        if (!isLive(tab.id)) return;
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
        pending.delete(tab.id);
        if (isLive(tab.id)) updateTab(tab.id, { loading: false });
      });
  };
  const cancel = () => {
    if (!tab.queryId || !tab.loading) return;
    if (paging.has(tab.id)) {
      updateTab(tab.id, { sessionId: undefined, queryId: undefined });
      void releaseDatabaseResources(databaseState, registry, { environmentId, projectId }, tab);
      return;
    }
    void databaseState.cancelQuery.run(registry, {
      environmentId,
      input: { projectId, queryId: tab.queryId },
    });
  };
  const more = async () => {
    if (tab.loading || tab.result?.kind !== "rows" || !tab.result.hasMore) return;
    if (!tab.queryId || pending.has(tab.id)) return;
    pending.add(tab.id);
    paging.add(tab.id);
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
      if (!isLive(tab.id)) return;
      if (current(tab.id)?.queryId !== queryId) throw new Error("Query cancelled.");
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
        // Closing the tab already released this query's resources.
        if (!isLive(tab.id)) return;
        const cancelled = current(tab.id)?.queryId === undefined;
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
        pending.delete(tab.id);
        paging.delete(tab.id);
      });
  };
  const filePath = tab.filePath ?? "query.sql";
  const queryFile = async (save: boolean) => {
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
  const switchConnection = (
    connection: DatabaseConnection,
    database = connection.target.engine === "postgres"
      ? connection.target.databaseSelection && connection.target.databaseSelection !== "all"
        ? connection.target.databaseSelection[0]
        : connection.target.database
      : undefined,
  ) => {
    if (tab.loading || (tab.connectionId === connection.id && databaseName === database)) return;
    void releaseDatabaseResources(databaseState, registry, { environmentId, projectId }, tab);
    updateTab(tab.id, {
      connectionId: connection.id,
      database,
      sessionId: undefined,
      queryId: undefined,
      result: undefined,
      error: undefined,
      errorAt: undefined,
      progress: undefined,
    });
  };
  if (!allowed) return <p className="p-3 text-sm">Database access requires terminal permission.</p>;
  const status = tab.loading
    ? tab.progress
      ? `Running ${tab.progress.index + 1} of ${tab.progress.total}`
      : "Running"
    : null;
  const result = (
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
  const editor = (
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
        {tabConnection?.target.engine === "postgres" && tabConnection.target.databaseSelection && (
          <Menu
            onOpenChange={(open) => {
              if (open) void loadDatabases();
            }}
          >
            <MenuTrigger
              disabled={tab.loading}
              render={
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={`Database: ${databaseName ?? "unavailable"}. Change database`}
                />
              }
            >
              <DatabaseIcon />
              <span className="max-w-40 truncate">{databaseName}</span>
              <ChevronDownIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              {(databaseList?.connectionId === tabConnection.id
                ? databaseList.names
                : databaseName
                  ? [databaseName]
                  : []
              ).map((name) => (
                <MenuItem key={name} onClick={() => switchConnection(tabConnection, name)}>
                  {name}
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        )}
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
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <DatabaseSplit
        direction="horizontal"
        label="Resize SQL editor and results"
        first={editor}
        second={result}
        initial={45}
      />
      {notice && (
        <p role="status" className="shrink-0 border-t px-3 py-1 text-xs text-muted-foreground">
          {notice}
        </p>
      )}
    </div>
  );
}
