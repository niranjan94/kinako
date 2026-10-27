import {
  DATABASE_PAGE_SIZE_DEFAULT,
  DatabaseRequestError,
  DatabaseQueryId,
  type DatabaseCell,
  type DatabaseProjectContext,
  type DatabaseOpenSessionInput,
  type DatabaseSessionInput,
  type DatabaseSessionId,
  type DatabaseBrowseTableInput,
  type DatabaseBrowseTableResult,
  type ProjectId,
  type DatabaseConnection,
  type DatabaseConnectionDraft,
  type DatabaseConnectionId,
  type DatabaseDeleteConnectionInput,
  type DatabaseExecuteInput,
  type DatabaseExecuteResult,
  type DatabaseFetchPageInput,
  type DatabaseFetchPageResult,
  type DatabaseIntrospectInput,
  type DatabaseIntrospectResult,
  type DatabaseListConnectionsResult,
  type DatabaseQueryInput,
  type DatabaseTestConnectionResult,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";

import * as DatabaseConnections from "./DatabaseConnections.ts";
import {
  cellWeight,
  DatabaseEngineError,
  isDatabaseEngineError,
  type DatabaseCursor,
  type DatabaseSession,
} from "./databaseDriver.ts";
import { openPostgresSession } from "./postgresDriver.ts";
import { openSqliteSession } from "./sqliteDriver.ts";

/** Result sets held open at once, across every client of this environment. */
const MAX_OPEN_QUERIES = 32;
/** Idle cursors hold database locks, so close them even while their editor stays open. */
const QUERY_IDLE_TIMEOUT = Duration.seconds(60);
/** Approximate characters per page; wide rows end a page before `pageSize` does. */
const MAX_EDITOR_SESSIONS = 32;
const PAGE_WEIGHT_BUDGET = 1_000_000;

type Row = ReadonlyArray<DatabaseCell>;

interface OpenQuery {
  readonly connectionId: DatabaseConnectionId;
  readonly projectId: ProjectId | undefined;
  editor: EditorSession | undefined;
  session: DatabaseSession | undefined;
  running: boolean;
  releasing?: Promise<void>;
  cursor: DatabaseCursor | undefined;
  /** Rows read from the engine that did not fit the last page. */
  buffer: Row[];
  done: boolean;
  cancelled: boolean;
  lastUsedMs: number;
  /** Serializes reads so two page requests never interleave on one cursor. */
  pending: Promise<unknown>;
}

interface EditorSession {
  readonly database: string | undefined;
  lastUsedMs: number;
  readonly connectionId: DatabaseConnectionId;
  readonly projectId: ProjectId | undefined;
  session: DatabaseSession | undefined;
  busy: boolean;
  closed: boolean;
  searchPath: readonly string[] | undefined;
}

export class DatabaseService extends Context.Service<
  DatabaseService,
  {
    readonly listConnections: (
      input?: DatabaseProjectContext,
    ) => Effect.Effect<DatabaseListConnectionsResult, DatabaseRequestError>;
    readonly saveConnection: (
      draft: DatabaseConnectionDraft,
    ) => Effect.Effect<DatabaseConnection, DatabaseRequestError>;
    readonly deleteConnection: (
      input: DatabaseDeleteConnectionInput,
    ) => Effect.Effect<void, DatabaseRequestError>;
    readonly testConnection: (
      draft: DatabaseConnectionDraft,
    ) => Effect.Effect<DatabaseTestConnectionResult, DatabaseRequestError>;
    readonly introspect: (
      input: DatabaseIntrospectInput,
    ) => Effect.Effect<DatabaseIntrospectResult, DatabaseRequestError>;
    readonly openSession: (
      input: DatabaseOpenSessionInput,
    ) => Effect.Effect<void, DatabaseRequestError>;
    readonly closeSession: (
      input: DatabaseSessionInput,
    ) => Effect.Effect<void, DatabaseRequestError>;
    readonly browseTable: (
      input: DatabaseBrowseTableInput,
    ) => Effect.Effect<DatabaseBrowseTableResult, DatabaseRequestError>;
    readonly execute: (
      input: DatabaseExecuteInput,
    ) => Effect.Effect<DatabaseExecuteResult, DatabaseRequestError>;
    readonly fetchPage: (
      input: DatabaseFetchPageInput,
    ) => Effect.Effect<DatabaseFetchPageResult, DatabaseRequestError>;
    readonly closeQuery: (input: DatabaseQueryInput) => Effect.Effect<void, DatabaseRequestError>;
    readonly cancelQuery: (input: DatabaseQueryInput) => Effect.Effect<void, DatabaseRequestError>;
  }
>()("t3/database/DatabaseService") {}

const toEngineError = (cause: unknown) =>
  isDatabaseEngineError(cause)
    ? cause
    : new DatabaseEngineError({
        engineMessage: "The database driver failed unexpectedly.",
        code: null,
        position: null,
        cancelled: false,
        cause,
      });

const engineRequestError = (error: DatabaseEngineError) =>
  new DatabaseRequestError({
    failure: "engine-failed",
    engineMessage: error.engineMessage,
    cause: error,
  });

/** Keeps at least one row, then stops before the page outweighs the budget. */
function splitByWeight(rows: ReadonlyArray<Row>): readonly [Row[], Row[]] {
  let weight = 0;
  for (let index = 0; index < rows.length; index++) {
    for (const cell of rows[index]!) weight += cellWeight(cell);
    if (weight > PAGE_WEIGHT_BUDGET && index > 0) {
      return [rows.slice(0, index), rows.slice(index)];
    }
  }
  return [[...rows], []];
}

const make = Effect.gen(function* () {
  const connections = yield* DatabaseConnections.DatabaseConnections;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sqliteInvocation = yield* resolveSelfInvocation();
  const queries = new Map<DatabaseQueryId, OpenQuery>();
  const editors = new Map<DatabaseSessionId, EditorSession>();

  const selectDatabase = Effect.fn("DatabaseService.selectDatabase")(function* (
    credentials: DatabaseConnections.DatabaseConnectionCredentials,
    requested: string | undefined,
  ) {
    const { target } = credentials.connection;
    if (target.engine === "sqlite") {
      if (requested !== undefined)
        return yield* new DatabaseRequestError({ failure: "database-not-selected" });
      return credentials;
    }
    const selection = target.databaseSelection;
    const database =
      requested ?? (selection && selection !== "all" ? selection[0]! : target.database);
    const allowed =
      selection === "all" ||
      (selection !== undefined ? selection.includes(database) : database === target.database);
    if (!allowed) return yield* new DatabaseRequestError({ failure: "database-not-selected" });
    return {
      ...credentials,
      connection: { ...credentials.connection, target: { ...target, database } },
    };
  });

  const missingSqliteFile = (credentials: DatabaseConnections.DatabaseConnectionCredentials) => {
    const { target } = credentials.connection;
    if (target.engine !== "sqlite") return Effect.void;
    if (!path.isAbsolute(target.path))
      return Effect.fail(
        new DatabaseEngineError({
          engineMessage: "Use an absolute SQLite file path on the environment.",
          code: null,
          position: null,
          cancelled: false,
        }),
      );
    return fileSystem.exists(target.path).pipe(
      Effect.orElseSucceed(() => false),
      Effect.flatMap((exists) =>
        exists
          ? Effect.void
          : Effect.fail(
              new DatabaseEngineError({
                engineMessage: `No SQLite database at ${target.path}.`,
                code: null,
                position: null,
                cancelled: false,
              }),
            ),
      ),
    );
  };

  const connect = (credentials: DatabaseConnections.DatabaseConnectionCredentials) =>
    missingSqliteFile(credentials).pipe(
      Effect.andThen(
        Effect.tryPromise({
          try: async (signal) => {
            const { target, readOnly } = credentials.connection;
            const session = await (target.engine === "postgres"
              ? openPostgresSession(target, credentials.password, readOnly)
              : openSqliteSession(target, readOnly, sqliteInvocation));
            if (signal.aborted) {
              await session.close();
              throw new DatabaseEngineError({
                engineMessage: "Query cancelled.",
                code: null,
                position: null,
                cancelled: true,
              });
            }
            return session;
          },
          catch: toEngineError,
        }),
      ),
    );

  const disconnect = (session: DatabaseSession) =>
    Effect.promise(() => session.close().catch(() => {}));

  const withSession = <A>(
    credentials: DatabaseConnections.DatabaseConnectionCredentials,
    use: (session: DatabaseSession) => Promise<A>,
  ) =>
    Effect.acquireUseRelease(
      connect(credentials),
      (session) => Effect.tryPromise({ try: () => use(session), catch: toEngineError }),
      disconnect,
    );

  const release = (queryId: DatabaseQueryId) =>
    Effect.promise(() => {
      const query = queries.get(queryId);
      if (!query) return Promise.resolve();
      if (query.releasing) return query.releasing;
      query.releasing = (async () => {
        if (query.running) {
          query.cancelled = true;
          if (query.editor) query.editor.closed = true;
          await query.session?.cancel().catch(() => {});
        }
        await query.cursor?.close().catch(() => {});
        if (!query.editor) await query.session?.close().catch(() => {});
        else {
          query.editor.busy = false;
          if (query.editor.closed || (query.cancelled && query.session?.cancelClosesSession)) {
            query.editor.closed = true;
            await query.session?.close().catch(() => {});
            for (const [id, editor] of editors) if (editor === query.editor) editors.delete(id);
          }
        }
        queries.delete(queryId);
      })();
      return query.releasing;
    });

  const assertProject = (actual: ProjectId | undefined, requested: ProjectId | undefined) =>
    actual === requested
      ? Effect.void
      : Effect.fail(new DatabaseRequestError({ failure: "project-mismatch" }));

  const listConnections = (input: DatabaseProjectContext = {}) =>
    connections.list(input).pipe(Effect.map((list) => ({ connections: list })));

  const closeEditor = Effect.fn("DatabaseService.closeEditor")(function* (id: DatabaseSessionId) {
    const editor = editors.get(id);
    if (!editor) return;
    editors.delete(id);
    editor.closed = true;
    yield* Effect.forEach(
      [...queries].filter(([, query]) => query.editor === editor),
      ([id]) => release(id),
      { discard: true },
    );
    if (editor.session) yield* disconnect(editor.session);
  });

  const closeSession = Effect.fn("DatabaseService.closeSession")(function* (
    input: DatabaseSessionInput,
  ) {
    const editor = editors.get(input.sessionId);
    if (!editor) return;
    yield* assertProject(editor.projectId, input.projectId);
    yield* closeEditor(input.sessionId);
  });

  const openSession = Effect.fn("DatabaseService.openSession")(function* (
    input: DatabaseOpenSessionInput,
  ) {
    const credentials = yield* selectDatabase(
      yield* connections.get(input.connectionId, input.projectId),
      input.database,
    );
    if (editors.has(input.sessionId))
      return yield* new DatabaseRequestError({ failure: "session-id-in-use" });
    if (editors.size >= MAX_EDITOR_SESSIONS)
      return yield* new DatabaseRequestError({ failure: "too-many-open-sessions" });
    const editor: EditorSession = {
      database:
        credentials.connection.target.engine === "postgres"
          ? credentials.connection.target.database
          : undefined,
      lastUsedMs: yield* Clock.currentTimeMillis,
      connectionId: input.connectionId,
      projectId: input.projectId,
      session: undefined,
      busy: true,
      closed: false,
      searchPath: undefined,
    };
    editors.set(input.sessionId, editor);
    yield* connect({
      ...credentials,
      connection: {
        ...credentials.connection,
        readOnly: credentials.connection.readOnly || input.forceReadOnly === true,
      },
    }).pipe(
      Effect.flatMap((session) =>
        Effect.gen(function* () {
          editor.session = session;
          if (editor.closed) {
            yield* disconnect(session);
            return yield* new DatabaseRequestError({ failure: "session-not-found" });
          }
          const metadata = yield* Effect.tryPromise({
            try: () => session.introspect({ kind: "schemas" }),
            catch: toEngineError,
          });
          if (metadata.kind === "schemas") editor.searchPath = metadata.searchPath;
          editor.busy = false;
        }),
      ),
      Effect.tapError(() => closeEditor(input.sessionId)),
      Effect.onInterrupt(() => closeEditor(input.sessionId)),
      Effect.catchTags({
        DatabaseEngineError: (error) => Effect.fail(engineRequestError(error)),
      }),
    );
  });

  const closeConnection = Effect.fn("DatabaseService.closeConnection")(function* (
    id: DatabaseConnectionId,
  ) {
    yield* Effect.forEach(
      [...queries].filter(([, query]) => query.connectionId === id),
      ([id]) => release(id),
      { discard: true },
    );
    yield* Effect.forEach(
      [...editors].filter(([, editor]) => editor.connectionId === id),
      ([id]) => closeEditor(id),
      { discard: true },
    );
  });

  const saveConnection = Effect.fn("DatabaseService.saveConnection")(function* (
    draft: DatabaseConnectionDraft,
  ) {
    const result = yield* connections.save(draft);
    yield* closeConnection(result.id);
    return result;
  });

  const deleteConnection = Effect.fn("DatabaseService.deleteConnection")(function* (
    input: DatabaseDeleteConnectionInput,
  ) {
    yield* closeConnection(input.id);
    yield* connections.remove(input.id);
  });

  const testConnection = (draft: DatabaseConnectionDraft) =>
    connections.resolveDraft(draft).pipe(
      Effect.flatMap((credentials) =>
        withSession(credentials, (session) => session.serverVersion()),
      ),
      Effect.map((serverVersion): DatabaseTestConnectionResult => ({ ok: true, serverVersion })),
      Effect.catchTags({
        DatabaseEngineError: (error) =>
          Effect.succeed<DatabaseTestConnectionResult>({ ok: false, message: error.engineMessage }),
      }),
    );

  const introspect = Effect.fn("DatabaseService.introspect")(
    function* (input: DatabaseIntrospectInput) {
      const saved = yield* connections.get(input.connectionId, input.projectId);
      if (input.scope.kind === "databases") {
        const target = saved.connection.target;
        if (target.engine === "sqlite") return { kind: "databases" as const, databases: [] };
        if (target.databaseSelection !== "all") {
          const names = target.databaseSelection ?? [target.database];
          return {
            kind: "databases" as const,
            databases: [...new Set(names)].map((name) => ({ name })),
          };
        }
        return yield* withSession(saved, (session) => session.introspect(input.scope));
      }
      const editor = input.sessionId ? editors.get(input.sessionId) : undefined;
      if (input.sessionId && (!editor || editor.closed))
        return yield* new DatabaseRequestError({ failure: "session-not-found" });
      if (editor) {
        yield* assertProject(editor.projectId, input.projectId);
        if (editor.connectionId !== input.connectionId)
          return yield* new DatabaseRequestError({ failure: "project-mismatch" });
      }
      const credentials = yield* selectDatabase(saved, input.database ?? editor?.database);
      if (
        editor &&
        credentials.connection.target.engine === "postgres" &&
        editor.database !== credentials.connection.target.database
      )
        return yield* new DatabaseRequestError({ failure: "database-not-selected" });
      // Metadata uses an independent connection so an unread console cursor cannot block it.
      const result = yield* withSession(credentials, (session) => session.introspect(input.scope));
      return result.kind === "schemas" && editor?.searchPath !== undefined
        ? { ...result, searchPath: editor.searchPath }
        : result;
    },
    Effect.catchTags({ DatabaseEngineError: (error) => Effect.fail(engineRequestError(error)) }),
  );

  const execute = Effect.fn("DatabaseService.execute")(
    function* (input: DatabaseExecuteInput) {
      if (queries.has(input.queryId))
        return yield* new DatabaseRequestError({ failure: "query-id-in-use" });
      if (queries.size >= MAX_OPEN_QUERIES)
        return yield* new DatabaseRequestError({ failure: "too-many-open-queries" });
      const startedMs = yield* Clock.currentTimeMillis;
      const pageSize = input.pageSize ?? DATABASE_PAGE_SIZE_DEFAULT;
      // Registered before connecting, so a cancel that arrives while connecting is honoured.
      const query: OpenQuery = {
        connectionId: input.connectionId,
        projectId: input.projectId,
        editor: undefined,
        session: undefined,
        running: true,
        cursor: undefined,
        buffer: [],
        done: false,
        cancelled: false,
        lastUsedMs: startedMs,
        pending: Promise.resolve(),
      };
      queries.set(input.queryId, query);

      return yield* Effect.gen(function* () {
        const editor = input.sessionId === undefined ? undefined : editors.get(input.sessionId);
        const credentials = yield* selectDatabase(
          yield* connections.get(input.connectionId, input.projectId),
          input.database ?? editor?.database,
        );
        if (input.sessionId !== undefined && (!editor || editor.closed || !editor.session))
          return yield* new DatabaseRequestError({ failure: "session-not-found" });
        if (editor) {
          yield* assertProject(editor.projectId, input.projectId);
          if (editor.connectionId !== input.connectionId)
            return yield* new DatabaseRequestError({ failure: "project-mismatch" });
          if (
            credentials.connection.target.engine === "postgres" &&
            editor.database !== credentials.connection.target.database
          )
            return yield* new DatabaseRequestError({ failure: "database-not-selected" });
          if (editor.busy) return yield* new DatabaseRequestError({ failure: "session-busy" });
          editor.busy = true;
          editor.lastUsedMs = yield* Clock.currentTimeMillis;
        }
        query.editor = editor;
        query.session = editor?.session;
        const elapsed = Clock.currentTimeMillis.pipe(
          Effect.map((now) => Math.max(0, Math.round(now - startedMs))),
        );

        const run = Effect.gen(function* () {
          if (!query.session)
            query.session = yield* connect({
              ...credentials,
              connection: {
                ...credentials.connection,
                readOnly: credentials.connection.readOnly || input.forceReadOnly === true,
              },
            });
          if (query.cancelled || queries.get(input.queryId) !== query || editor?.closed) {
            if (!editor || editor.closed) yield* disconnect(query.session);
            return yield* new DatabaseEngineError({
              engineMessage: "Query cancelled.",
              code: null,
              position: null,
              cancelled: true,
            });
          }
          const session = query.session;
          return yield* Effect.tryPromise({
            try: () => session.execute(input.sql, pageSize),
            catch: toEngineError,
          });
        });

        return yield* run.pipe(
          Effect.flatMap((outcome) =>
            Effect.gen(function* () {
              if (outcome.kind === "rows") query.cursor = outcome.cursor;
              query.running = false;
              if (query.cancelled)
                return yield* new DatabaseEngineError({
                  engineMessage: "Query cancelled.",
                  code: null,
                  position: null,
                  cancelled: true,
                });
              query.lastUsedMs = yield* Clock.currentTimeMillis;
              const durationMs = yield* elapsed;
              if (outcome.kind === "command") {
                if (editor) {
                  const metadata = yield* Effect.promise(() =>
                    query.session!.introspect({ kind: "schemas" }).catch(() => undefined),
                  );
                  if (metadata?.kind === "schemas") editor.searchPath = metadata.searchPath;
                }
                yield* release(input.queryId);
                return {
                  kind: "command",
                  command: outcome.command,
                  affectedRows: outcome.affectedRows,
                  durationMs,
                } satisfies DatabaseExecuteResult;
              }
              const [rows, rest] = splitByWeight(outcome.firstPage.rows);
              query.cursor = outcome.cursor;
              query.buffer = rest;
              query.done = outcome.firstPage.done;
              const hasMore = !query.done || rest.length > 0;
              if (!hasMore) yield* release(input.queryId);
              return {
                kind: "rows",
                columns: outcome.cursor.columns,
                rows,
                hasMore,
                durationMs,
              } satisfies DatabaseExecuteResult;
            }),
          ),
          Effect.catchTags({
            // The enclosing operation owns the span for this inline handler.
            DatabaseEngineError: Effect.fnUntraced(function* (error) {
              query.running = false;
              if (editor && query.cancelled && query.session?.cancelClosesSession)
                editor.closed = true;
              yield* release(input.queryId);
              if (editor?.closed && input.sessionId) yield* closeEditor(input.sessionId);
              return {
                kind: "failed",
                message: error.engineMessage,
                code: error.code,
                position: error.position,
                cancelled: error.cancelled || query.cancelled,
                durationMs: yield* elapsed,
              } satisfies DatabaseExecuteResult;
            }),
          }),
        );
      }).pipe(Effect.tapError(() => release(input.queryId)));
    },
    (effect, input) => effect.pipe(Effect.onInterrupt(() => release(input.queryId))),
  );

  const fetchPage = Effect.fn("DatabaseService.fetchPage")(function* (
    input: DatabaseFetchPageInput,
  ) {
    const query = queries.get(input.queryId);
    if (query?.releasing) {
      yield* Effect.promise(() => query.releasing!);
      return yield* new DatabaseRequestError({ failure: "query-not-found" });
    }
    if (!query?.cursor) return yield* new DatabaseRequestError({ failure: "query-not-found" });
    yield* assertProject(query.projectId, input.projectId);
    yield* connections.get(query.connectionId, input.projectId);
    const cursor = query.cursor;
    const pageSize = input.pageSize ?? DATABASE_PAGE_SIZE_DEFAULT;
    query.lastUsedMs = yield* Clock.currentTimeMillis;

    const read = async () => {
      if (queries.get(input.queryId) !== query || query.releasing)
        throw new DatabaseEngineError({
          engineMessage: "This result has closed.",
          code: null,
          position: null,
          cancelled: true,
        });
      query.running = true;
      const rows = query.buffer.splice(0, pageSize);
      if (rows.length < pageSize && !query.done) {
        const page = await cursor.read(pageSize - rows.length);
        rows.push(...page.rows);
        query.done = page.done;
      }
      const [kept, rest] = splitByWeight(rows);
      query.buffer = [...rest, ...query.buffer];
      query.running = false;
      return kept;
    };
    const next = query.pending.then(read);
    query.pending = next.catch(() => {});

    const rows = yield* Effect.tryPromise({ try: () => next, catch: toEngineError }).pipe(
      Effect.tapError(() => release(input.queryId)),
      Effect.catchTags({
        DatabaseEngineError: (error) => Effect.fail(engineRequestError(error)),
      }),
    );
    const hasMore = !query.done || query.buffer.length > 0;
    if (!hasMore) yield* release(input.queryId);
    return { rows, hasMore };
  });

  const closeQuery = Effect.fn("DatabaseService.closeQuery")(function* (input: DatabaseQueryInput) {
    const query = queries.get(input.queryId);
    if (query) yield* assertProject(query.projectId, input.projectId);
    yield* release(input.queryId);
  });

  const cancelQuery = Effect.fn("DatabaseService.cancelQuery")(function* (
    input: DatabaseQueryInput,
  ) {
    const query = queries.get(input.queryId);
    if (!query) return;
    yield* assertProject(query.projectId, input.projectId);
    query.cancelled = true;
    // A result already sitting open has nothing running to stop; cancelling it closes it.
    if (query.cursor) return yield* release(input.queryId);
    const session = query.session;
    if (session) yield* Effect.promise(() => session.cancel().catch(() => {}));
  });

  const closeIdle = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const cutoff = now - Duration.toMillis(QUERY_IDLE_TIMEOUT);
    const idle = [...queries].filter(
      ([, query]) => query.cursor && !query.running && query.lastUsedMs <= cutoff,
    );
    yield* Effect.forEach(idle, ([queryId]) => release(queryId), { discard: true });
    yield* Effect.forEach(
      [...editors].filter(
        ([, editor]) =>
          !editor.busy && editor.lastUsedMs <= now - Duration.toMillis(Duration.minutes(30)),
      ),
      ([id]) => closeEditor(id),
      { discard: true },
    );
  });

  yield* closeIdle.pipe(Effect.repeat(Schedule.spaced(Duration.seconds(5))), Effect.forkScoped);
  yield* Effect.addFinalizer(() => Effect.forEach([...queries.keys()], release, { discard: true }));

  yield* Effect.addFinalizer(() =>
    Effect.forEach([...editors.keys()], closeEditor, { discard: true }),
  );

  const browseTable = Effect.fn("DatabaseService.browseTable")(function* (
    input: DatabaseBrowseTableInput,
  ) {
    const credentials = yield* selectDatabase(
      yield* connections.get(input.connectionId, input.projectId),
      input.database,
    );
    const pageSize = input.pageSize ?? DATABASE_PAGE_SIZE_DEFAULT;
    const offset = input.offset ?? 0;
    return yield* withSession(
      { ...credentials, connection: { ...credentials.connection, readOnly: true } },
      async (session) => {
        const metadata = await session.introspect({
          kind: "columns",
          schema: input.schema,
          object: input.object,
        });
        const keys =
          metadata.kind === "columns"
            ? metadata.columns.filter((column) => column.primaryKey).map((column) => column.name)
            : [];
        const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
        const literal = (value: string | number | boolean | null) =>
          value === null
            ? "NULL"
            : typeof value === "boolean"
              ? value
                ? "TRUE"
                : "FALSE"
              : typeof value === "number"
                ? String(value)
                : "'" + value.replaceAll("'", "''") + "'";
        const useKeyset =
          keys.length > 0 &&
          !input.orderBy?.trim() &&
          (!input.after ||
            (input.after.length === keys.length && input.after.every((value) => value !== null)));
        const filters = input.where?.trim() ? ["(" + input.where + ")"] : [];
        if (useKeyset && input.after)
          filters.push(
            "(" + keys.map(quote).join(", ") + ") > (" + input.after.map(literal).join(", ") + ")",
          );
        const order = input.orderBy?.trim() || (keys.length ? keys.map(quote).join(", ") : "");
        const sql =
          "SELECT * FROM " +
          quote(input.schema) +
          "." +
          quote(input.object) +
          (filters.length ? " WHERE " + filters.join(" AND ") : "") +
          (order ? " ORDER BY " + order : "") +
          " LIMIT " +
          (pageSize + 1) +
          (useKeyset && input.after ? "" : " OFFSET " + offset);
        const outcome = await session.execute(sql, pageSize + 1);
        if (outcome.kind !== "rows")
          throw new DatabaseEngineError({
            engineMessage: "The table did not return rows.",
            code: null,
            position: null,
            cancelled: false,
          });
        try {
          const [bounded] = splitByWeight(outcome.firstPage.rows.slice(0, pageSize));
          const last = bounded.at(-1);
          const after =
            useKeyset && last
              ? keys.map(
                  (key) =>
                    last[outcome.cursor.columns.findIndex((column) => column.name === key)] ?? null,
                )
              : null;
          const nextAfter =
            after && after.every((value) => value !== null && typeof value !== "object")
              ? (after as Array<string | number | boolean>)
              : null;
          return {
            columns: outcome.cursor.columns,
            rows: bounded,
            hasMore: bounded.length < outcome.firstPage.rows.length || !outcome.firstPage.done,
            nextOffset: offset + bounded.length,
            nextAfter,
          };
        } finally {
          await outcome.cursor.close();
        }
      },
    ).pipe(
      Effect.catchTags({
        DatabaseEngineError: (error) => Effect.fail(engineRequestError(error)),
      }),
    );
  });

  return DatabaseService.of({
    openSession,
    closeSession,
    browseTable,
    listConnections,
    saveConnection,
    deleteConnection,
    testConnection,
    introspect,
    execute,
    fetchPage,
    closeQuery,
    cancelQuery,
  });
});

export const layer = Layer.effect(DatabaseService, make).pipe(
  Layer.provide(DatabaseConnections.layer),
);
