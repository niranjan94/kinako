import {
  DATABASE_PAGE_SIZE_DEFAULT,
  DatabaseRequestError,
  type DatabaseCell,
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
  type DatabaseQueryId,
  type DatabaseQueryInput,
  type DatabaseTestConnectionResult,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
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
/** An open result nobody has paged for this long is closed, releasing its connection. */
const QUERY_IDLE_TIMEOUT = Duration.minutes(10);
/** Approximate characters per page; wide rows end a page before `pageSize` does. */
const PAGE_WEIGHT_BUDGET = 1_000_000;

type Row = ReadonlyArray<DatabaseCell>;

interface OpenQuery {
  readonly connectionId: DatabaseConnectionId;
  session: DatabaseSession | undefined;
  cursor: DatabaseCursor | undefined;
  /** Rows read from the engine that did not fit the last page. */
  buffer: Row[];
  done: boolean;
  cancelled: boolean;
  lastUsedMs: number;
  /** Serializes reads so two page requests never interleave on one cursor. */
  pending: Promise<unknown>;
}

export class DatabaseService extends Context.Service<
  DatabaseService,
  {
    readonly listConnections: () => Effect.Effect<
      DatabaseListConnectionsResult,
      DatabaseRequestError
    >;
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
    readonly execute: (
      input: DatabaseExecuteInput,
    ) => Effect.Effect<DatabaseExecuteResult, DatabaseRequestError>;
    readonly fetchPage: (
      input: DatabaseFetchPageInput,
    ) => Effect.Effect<DatabaseFetchPageResult, DatabaseRequestError>;
    readonly closeQuery: (input: DatabaseQueryInput) => Effect.Effect<void>;
    readonly cancelQuery: (input: DatabaseQueryInput) => Effect.Effect<void>;
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
  const queries = new Map<DatabaseQueryId, OpenQuery>();

  const missingSqliteFile = (credentials: DatabaseConnections.DatabaseConnectionCredentials) => {
    const { target } = credentials.connection;
    if (target.engine !== "sqlite") return Effect.void;
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

  const openSession = (credentials: DatabaseConnections.DatabaseConnectionCredentials) =>
    missingSqliteFile(credentials).pipe(
      Effect.andThen(
        Effect.tryPromise({
          try: () => {
            const { target, readOnly } = credentials.connection;
            return target.engine === "postgres"
              ? openPostgresSession(target, credentials.password, readOnly)
              : openSqliteSession(target, readOnly);
          },
          catch: toEngineError,
        }),
      ),
    );

  const closeSession = (session: DatabaseSession) =>
    Effect.promise(() => session.close().catch(() => {}));

  const withSession = <A>(
    credentials: DatabaseConnections.DatabaseConnectionCredentials,
    use: (session: DatabaseSession) => Promise<A>,
  ) =>
    Effect.acquireUseRelease(
      openSession(credentials),
      (session) => Effect.tryPromise({ try: () => use(session), catch: toEngineError }),
      closeSession,
    );

  const release = (queryId: DatabaseQueryId) =>
    Effect.promise(async () => {
      const query = queries.get(queryId);
      if (!query) return;
      queries.delete(queryId);
      await query.cursor?.close().catch(() => {});
      await query.session?.close().catch(() => {});
    });

  const listConnections = () =>
    connections.list().pipe(Effect.map((list) => ({ connections: list })));

  const deleteConnection = (input: DatabaseDeleteConnectionInput) =>
    Effect.gen(function* () {
      const open = [...queries].filter(([, query]) => query.connectionId === input.id);
      yield* Effect.forEach(open, ([queryId]) => release(queryId), { discard: true });
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

  const introspect = (input: DatabaseIntrospectInput) =>
    connections.get(input.connectionId).pipe(
      Effect.flatMap((credentials) =>
        withSession(credentials, (session) => session.introspect(input.scope)),
      ),
      Effect.catchTags({ DatabaseEngineError: (error) => Effect.fail(engineRequestError(error)) }),
    );

  const execute = (input: DatabaseExecuteInput) =>
    Effect.gen(function* () {
      if (queries.has(input.queryId)) {
        return yield* new DatabaseRequestError({ failure: "query-id-in-use" });
      }
      if (queries.size >= MAX_OPEN_QUERIES) {
        return yield* new DatabaseRequestError({ failure: "too-many-open-queries" });
      }
      const credentials = yield* connections.get(input.connectionId);
      const startedMs = yield* Clock.currentTimeMillis;
      const pageSize = input.pageSize ?? DATABASE_PAGE_SIZE_DEFAULT;
      // Registered before connecting, so a cancel that arrives while connecting is honoured.
      const query: OpenQuery = {
        connectionId: input.connectionId,
        session: undefined,
        cursor: undefined,
        buffer: [],
        done: false,
        cancelled: false,
        lastUsedMs: startedMs,
        pending: Promise.resolve(),
      };
      queries.set(input.queryId, query);

      const elapsed = Clock.currentTimeMillis.pipe(
        Effect.map((now) => Math.max(0, Math.round(now - startedMs))),
      );

      const run = Effect.gen(function* () {
        query.session = yield* openSession(credentials);
        if (query.cancelled) {
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
            const durationMs = yield* elapsed;
            if (outcome.kind === "command") {
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
          DatabaseEngineError: (error) =>
            Effect.gen(function* () {
              yield* release(input.queryId);
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
    });

  const fetchPage = (input: DatabaseFetchPageInput) =>
    Effect.gen(function* () {
      const query = queries.get(input.queryId);
      if (!query?.cursor) return yield* new DatabaseRequestError({ failure: "query-not-found" });
      const cursor = query.cursor;
      const pageSize = input.pageSize ?? DATABASE_PAGE_SIZE_DEFAULT;
      query.lastUsedMs = yield* Clock.currentTimeMillis;

      const read = async () => {
        const rows = query.buffer.splice(0, pageSize);
        if (rows.length < pageSize && !query.done) {
          const page = await cursor.read(pageSize - rows.length);
          rows.push(...page.rows);
          query.done = page.done;
        }
        const [kept, rest] = splitByWeight(rows);
        query.buffer = [...rest, ...query.buffer];
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

  const closeQuery = (input: DatabaseQueryInput) => release(input.queryId);

  const cancelQuery = (input: DatabaseQueryInput) =>
    Effect.gen(function* () {
      const query = queries.get(input.queryId);
      if (!query) return;
      query.cancelled = true;
      // A result already sitting open has nothing running to stop; cancelling it closes it.
      if (query.cursor) return yield* release(input.queryId);
      const session = query.session;
      if (session) yield* Effect.promise(() => session.cancel().catch(() => {}));
    });

  const closeIdle = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const cutoff = now - Duration.toMillis(QUERY_IDLE_TIMEOUT);
    const idle = [...queries].filter(([, query]) => query.cursor && query.lastUsedMs < cutoff);
    yield* Effect.forEach(idle, ([queryId]) => release(queryId), { discard: true });
  });

  yield* closeIdle.pipe(Effect.repeat(Schedule.spaced(Duration.minutes(1))), Effect.forkScoped);
  yield* Effect.addFinalizer(() => Effect.forEach([...queries.keys()], release, { discard: true }));

  return DatabaseService.of({
    listConnections,
    saveConnection: connections.save,
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
