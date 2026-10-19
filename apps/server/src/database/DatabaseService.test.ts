import * as NodeURL from "node:url";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  DATABASE_CELL_TEXT_MAX,
  DatabaseQueryId,
  DatabaseSessionId,
  DatabaseConnectionId,
  ProjectId,
  type DatabaseConnection,
  type DatabaseExecuteResult,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as DatabaseService from "./DatabaseService.ts";

const secrets = new Map<string, Uint8Array>();
const secretStore = Layer.succeed(
  ServerSecretStore.ServerSecretStore,
  ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromUndefinedOr(secrets.get(name))),
    set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
    remove: (name) => Effect.sync(() => void secrets.delete(name)),
    create: () => Effect.die("unused"),
    getOrCreateRandom: () => Effect.die("unused"),
  }),
);

const layer = it.layer(
  DatabaseService.layer.pipe(
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(secretStore),
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(
      Layer.succeed(HostProcess.Arguments, [
        process.execPath,
        NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
      ]),
    ),
  ),
);

let queryCounter = 0;
const nextQueryId = () => DatabaseQueryId.make(`query-${++queryCounter}`);

/** A saved connection to an empty SQLite file; SQLite reads a zero-byte file as a new database. */
const sqliteConnection = (readOnly = false) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const path = `${directory}/shop.sqlite`;
    yield* fileSystem.writeFile(path, new Uint8Array());
    const database = yield* DatabaseService.DatabaseService;
    return yield* database.saveConnection({
      level: "environment",
      name: "shop",
      target: { engine: "sqlite", path },
      readOnly,
    });
  });

const run = (connection: DatabaseConnection, sql: string, pageSize?: number) =>
  Effect.gen(function* () {
    const database = yield* DatabaseService.DatabaseService;
    const queryId = nextQueryId();
    const result = yield* database.execute({
      connectionId: connection.id,
      queryId,
      sql,
      ...(pageSize === undefined ? {} : { pageSize }),
    });
    return { queryId, result };
  });

function expectKind<K extends DatabaseExecuteResult["kind"]>(
  result: DatabaseExecuteResult,
  kind: K,
): Extract<DatabaseExecuteResult, { kind: K }> {
  assert.strictEqual(result.kind, kind, JSON.stringify(result));
  return result as Extract<DatabaseExecuteResult, { kind: K }>;
}

const seedOrders = (connection: DatabaseConnection) =>
  Effect.gen(function* () {
    yield* run(connection, "CREATE TABLE customers (id INTEGER PRIMARY KEY, email TEXT NOT NULL)");
    yield* run(
      connection,
      `CREATE TABLE orders (
        id INTEGER PRIMARY KEY,
        customer_id INTEGER REFERENCES customers (id),
        note TEXT DEFAULT 'none'
      )`,
    );
    yield* run(
      connection,
      `INSERT INTO orders (id, customer_id)
       WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 450)
       SELECT i, NULL FROM n`,
    );
  });

layer("DatabaseService", (it) => {
  if (process.env.T3_TEST_POSTGRES_PORT) {
    it.effect("uses console search_path for completion while a result cursor is open", () =>
      Effect.gen(function* () {
        const database = yield* DatabaseService.DatabaseService;
        const connection = yield* database.saveConnection({
          level: "environment",
          name: "postgres-context",
          readOnly: false,
          target: {
            engine: "postgres",
            host: "127.0.0.1",
            port: Number(process.env.T3_TEST_POSTGRES_PORT),
            database: "postgres",
            user: "postgres",
            sslMode: "disable",
          },
          password: "kinako-issue15-test",
        });
        const sessionId = DatabaseSessionId.make("completion-path");
        yield* database.openSession({ connectionId: connection.id, sessionId });
        const execute = (sql: string) =>
          database.execute({ connectionId: connection.id, sessionId, queryId: nextQueryId(), sql });
        expectKind(yield* execute("CREATE SCHEMA completion_service_tenant"), "command");
        expectKind(
          yield* execute("SET search_path TO completion_service_tenant, public"),
          "command",
        );
        const queryId = nextQueryId();
        expectKind(
          yield* database.execute({
            connectionId: connection.id,
            sessionId,
            queryId,
            sql: "SELECT generate_series(1, 5)",
            pageSize: 1,
          }),
          "rows",
        );
        const metadata = yield* database.introspect({
          connectionId: connection.id,
          sessionId,
          scope: { kind: "schemas" },
        });
        assert.deepStrictEqual(metadata.kind === "schemas" && metadata.searchPath, [
          "completion_service_tenant",
          "public",
        ]);
        yield* database.closeQuery({ queryId });
        expectKind(yield* execute("SET search_path TO public"), "command");
        const reset = yield* database.introspect({
          connectionId: connection.id,
          sessionId,
          scope: { kind: "schemas" },
        });
        assert.deepStrictEqual(reset.kind === "schemas" && reset.searchPath, ["public"]);
        expectKind(yield* execute("DROP SCHEMA completion_service_tenant"), "command");
        yield* database.closeSession({ sessionId });
      }),
    );
  }
  it.effect("keeps passwords on the server and edits them only when asked", () =>
    Effect.gen(function* () {
      const database = yield* DatabaseService.DatabaseService;
      const target = {
        engine: "postgres",
        host: "localhost",
        port: 5432,
        database: "shop",
        user: "app",
        sslMode: "disable",
      } as const;
      const saved = yield* database.saveConnection({
        level: "environment",
        name: "prod",
        target,
        readOnly: true,
        password: "hunter2",
      });
      assert.isTrue(saved.hasPassword);
      assert.notInclude(JSON.stringify(yield* database.listConnections()), "hunter2");

      const renamed = yield* database.saveConnection({
        level: "environment",
        id: saved.id,
        name: "production",
        target,
        readOnly: true,
      });
      assert.strictEqual(renamed.name, "production");
      assert.isTrue(renamed.hasPassword, "an omitted password keeps the stored one");
      assert.strictEqual(renamed.createdAt, saved.createdAt);

      const cleared = yield* database.saveConnection({
        level: "environment",
        id: saved.id,
        name: "production",
        target,
        readOnly: true,
        password: null,
      });
      assert.isFalse(cleared.hasPassword);

      yield* database.saveConnection({
        level: "environment",
        id: saved.id,
        name: "production",
        target,
        readOnly: true,
        password: "hunter2",
      });
      const switchedToAws = yield* database.saveConnection({
        level: "environment",
        id: saved.id,
        name: "production",
        target: { ...target, auth: { kind: "aws-iam", region: "ap-southeast-1" } },
        readOnly: true,
      });
      assert.isFalse(switchedToAws.hasPassword, "AWS sign-in drops a stored password");

      yield* database.deleteConnection({ id: saved.id });
      yield* database.deleteConnection({ id: saved.id });
      const { connections } = yield* database.listConnections();
      assert.isFalse(connections.some((connection) => connection.id === saved.id));
    }),
  );

  it.effect("pages a result set and releases it once read to the end", () =>
    Effect.gen(function* () {
      const database = yield* DatabaseService.DatabaseService;
      const connection = yield* sqliteConnection();
      yield* seedOrders(connection);

      const { queryId, result } = yield* run(
        connection,
        "SELECT id, note FROM orders ORDER BY id",
        200,
      );
      const first = expectKind(result, "rows");
      assert.deepStrictEqual(
        first.columns.map((column) => column.name),
        ["id", "note"],
      );
      assert.strictEqual(first.rows.length, 200);
      assert.deepStrictEqual(first.rows[0], [1, "none"]);
      assert.isTrue(first.hasMore);

      const second = yield* database.fetchPage({ queryId, pageSize: 200 });
      assert.strictEqual(second.rows[0]?.[0], 201);
      assert.isTrue(second.hasMore);
      const last = yield* database.fetchPage({ queryId, pageSize: 200 });
      assert.strictEqual(last.rows.length, 50);
      assert.isFalse(last.hasMore);

      const afterEnd = yield* Effect.exit(database.fetchPage({ queryId }));
      assert.isTrue(Exit.isFailure(afterEnd), "an exhausted result is closed on the server");
    }),
  );

  it.effect("reports SQL errors and read-only refusals as results the user reads", () =>
    Effect.gen(function* () {
      const writable = yield* sqliteConnection();
      const typo = expectKind((yield* run(writable, "SELEC 1")).result, "failed");
      assert.include(typo.message, "syntax error");
      assert.isFalse(typo.cancelled);

      const command = expectKind(
        (yield* run(writable, "CREATE TABLE notes (body TEXT)")).result,
        "command",
      );
      assert.strictEqual(command.command, "CREATE");

      const database = yield* DatabaseService.DatabaseService;
      const readOnly = yield* database.saveConnection({
        level: "environment",
        name: "shop (read-only)",
        target: writable.target,
        readOnly: true,
      });
      const refused = expectKind(
        (yield* run(readOnly, "INSERT INTO notes VALUES ('x')")).result,
        "failed",
      );
      assert.include(refused.message, "readonly");
    }),
  );

  it.effect("does not create a database for a path that does not exist", () =>
    Effect.gen(function* () {
      const database = yield* DatabaseService.DatabaseService;
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const path = `${directory}/typo.sqlite`;
      const connection = yield* database.saveConnection({
        level: "environment",
        name: "typo",
        target: { engine: "sqlite", path },
        readOnly: false,
      });
      const missing = expectKind((yield* run(connection, "SELECT 1")).result, "failed");
      assert.include(missing.message, "No SQLite database");
      assert.isFalse(yield* fileSystem.exists(path));

      const tested = yield* database.testConnection({
        level: "environment",
        id: connection.id,
        name: "typo",
        target: connection.target,
        readOnly: false,
      });
      assert.isFalse(tested.ok);
    }),
  );

  it.effect("cuts long text cells and keeps their full length", () =>
    Effect.gen(function* () {
      const connection = yield* sqliteConnection();
      const result = expectKind(
        (yield* run(connection, `SELECT printf('%.*c', ${DATABASE_CELL_TEXT_MAX + 500}, 'x')`))
          .result,
        "rows",
      );
      assert.deepStrictEqual(result.rows[0]?.[0], {
        truncated: "x".repeat(DATABASE_CELL_TEXT_MAX),
        length: DATABASE_CELL_TEXT_MAX + 500,
      });
    }),
  );

  it.effect("introspects schemas, objects, then one object's columns", () =>
    Effect.gen(function* () {
      const database = yield* DatabaseService.DatabaseService;
      const connection = yield* sqliteConnection();
      yield* seedOrders(connection);
      const introspect = (scope: Parameters<typeof database.introspect>[0]["scope"]) =>
        database.introspect({ connectionId: connection.id, scope });

      assert.deepStrictEqual(yield* introspect({ kind: "schemas" }), {
        kind: "schemas",
        schemas: [{ name: "main" }],
      });
      assert.deepStrictEqual(yield* introspect({ kind: "objects", schema: "main" }), {
        kind: "objects",
        objects: [
          { name: "customers", type: "table" },
          { name: "orders", type: "table" },
        ],
      });
      const columns = yield* introspect({ kind: "columns", schema: "main", object: "orders" });
      assert.deepStrictEqual(columns, {
        kind: "columns",
        columns: [
          {
            name: "id",
            dataType: "INTEGER",
            nullable: false,
            defaultValue: null,
            primaryKey: true,
            references: null,
          },
          {
            name: "customer_id",
            dataType: "INTEGER",
            nullable: true,
            defaultValue: null,
            primaryKey: false,
            references: { schema: "main", object: "customers", column: "id" },
          },
          {
            name: "note",
            dataType: "TEXT",
            nullable: true,
            defaultValue: "'none'",
            primaryKey: false,
            references: null,
          },
        ],
      });
    }),
  );

  it.effect("closing a result releases it, and closing an unknown one is a no-op", () =>
    Effect.gen(function* () {
      const database = yield* DatabaseService.DatabaseService;
      const connection = yield* sqliteConnection();
      yield* seedOrders(connection);
      const { queryId, result } = yield* run(connection, "SELECT id FROM orders", 10);
      assert.isTrue(expectKind(result, "rows").hasMore);

      yield* database.closeQuery({ queryId });
      yield* database.closeQuery({ queryId });
      yield* database.cancelQuery({ queryId });
      const exit = yield* Effect.exit(database.fetchPage({ queryId }));
      assert.isTrue(Exit.isFailure(exit));
    }),
  );
  it.effect(
    "retains temp tables across statements in an editor and releases the session on close",
    () =>
      Effect.gen(function* () {
        const database = yield* DatabaseService.DatabaseService;
        const connection = yield* sqliteConnection();
        const sessionId = DatabaseSessionId.make("temp-editor");
        yield* database.openSession({ connectionId: connection.id, sessionId });
        const execute = (sql: string) =>
          database.execute({ connectionId: connection.id, sessionId, queryId: nextQueryId(), sql });
        expectKind(yield* execute("CREATE TEMP TABLE scratch (value TEXT)"), "command");
        expectKind(yield* execute("INSERT INTO scratch VALUES ('persistent')"), "command");
        assert.deepStrictEqual(expectKind(yield* execute("SELECT * FROM scratch"), "rows").rows, [
          ["persistent"],
        ]);
        yield* database.closeSession({ sessionId });
        const error = yield* execute("SELECT 1").pipe(Effect.flip);
        assert.strictEqual(error.failure, "session-not-found");
      }),
  );

  it.effect(
    "expires idle cursors after sixty seconds and frees the editor for another statement",
    () =>
      Effect.gen(function* () {
        const database = yield* DatabaseService.DatabaseService;
        const connection = yield* sqliteConnection();
        const sessionId = DatabaseSessionId.make("idle-editor");
        yield* database.openSession({ connectionId: connection.id, sessionId });
        const queryId = nextQueryId();
        const result = yield* database.execute({
          connectionId: connection.id,
          sessionId,
          queryId,
          sql: "SELECT 1 UNION ALL SELECT 2",
          pageSize: 1,
        });
        assert.isTrue(expectKind(result, "rows").hasMore);
        yield* TestClock.adjust("65 seconds");
        const error = yield* database.fetchPage({ queryId }).pipe(Effect.flip);
        assert.strictEqual(error.failure, "query-not-found");
        expectKind(
          yield* database.execute({
            connectionId: connection.id,
            sessionId,
            queryId: nextQueryId(),
            sql: "SELECT 3",
          }),
          "rows",
        );
        yield* database.closeSession({ sessionId });
      }),
  );

  it.effect("pages tables without retaining a cursor or blocking a write between pages", () =>
    Effect.gen(function* () {
      const database = yield* DatabaseService.DatabaseService;
      const connection = yield* sqliteConnection();
      yield* seedOrders(connection);
      const input = { connectionId: connection.id, schema: "main", object: "orders", pageSize: 10 };
      const first = yield* database.browseTable(input);
      assert.lengthOf(first.rows, 10);
      assert.deepStrictEqual(first.nextAfter, [10]);
      expectKind(
        (yield* run(connection, "UPDATE orders SET note = 'changed' WHERE id = 11")).result,
        "command",
      );
      const second = yield* database.browseTable({
        ...input,
        offset: first.nextOffset,
        after: first.nextAfter!,
      });
      assert.deepStrictEqual(second.rows[0], [11, null, "changed"]);
    }),
  );

  it.effect("scopes visibility, introspection, execution, sessions and paging to the project", () =>
    Effect.gen(function* () {
      const database = yield* DatabaseService.DatabaseService;
      const base = yield* sqliteConnection();
      const projectId = ProjectId.make("database-project");
      const other = ProjectId.make("other-project");
      const connection = yield* database.saveConnection({
        id: base.id,
        level: "project",
        projectId,
        target: base.target,
        name: "project-db",
        readOnly: false,
      });
      assert.isFalse(
        (yield* database.listConnections()).connections.some((item) => item.id === connection.id),
      );
      assert.isTrue(
        (yield* database.listConnections({ projectId })).connections.some(
          (item) => item.id === connection.id,
        ),
      );
      assert.strictEqual(
        (yield* database
          .introspect({ connectionId: connection.id, projectId: other, scope: { kind: "schemas" } })
          .pipe(Effect.flip)).failure,
        "project-mismatch",
      );
      assert.strictEqual(
        (yield* database
          .openSession({
            connectionId: connection.id,
            projectId: other,
            sessionId: DatabaseSessionId.make("wrong-project"),
          })
          .pipe(Effect.flip)).failure,
        "project-mismatch",
      );
      assert.strictEqual(
        (yield* database
          .execute({
            connectionId: connection.id,
            projectId: other,
            queryId: nextQueryId(),
            sql: "SELECT 1",
          })
          .pipe(Effect.flip)).failure,
        "project-mismatch",
      );
      const queryId = nextQueryId();
      yield* database.execute({
        connectionId: connection.id,
        projectId,
        queryId,
        sql: "SELECT 1 UNION ALL SELECT 2",
        pageSize: 1,
      });
      assert.strictEqual(
        (yield* database.fetchPage({ projectId: other, queryId }).pipe(Effect.flip)).failure,
        "project-mismatch",
      );
      yield* database.closeQuery({ queryId, projectId });
    }),
  );

  it.effect("accepts linked global Postgres ids and refuses global SQLite", () =>
    Effect.gen(function* () {
      const database = yield* DatabaseService.DatabaseService;
      const id = DatabaseConnectionId.make("linked-global");
      const connection = yield* database.saveConnection({
        id,
        name: "global",
        level: "global",
        readOnly: true,
        target: {
          engine: "postgres",
          host: "db.example.com",
          port: 5432,
          database: "app",
          user: "reader",
          sslMode: "require",
        },
      });
      assert.strictEqual(connection.id, id);
      assert.isTrue(
        (yield* database.listConnections({
          projectId: ProjectId.make("any-project"),
        })).connections.some((item) => item.id === id),
      );
      const local = yield* sqliteConnection();
      assert.strictEqual(
        (yield* database
          .saveConnection({ name: "bad", level: "global", target: local.target, readOnly: true })
          .pipe(Effect.flip)).failure,
        "invalid-connection-level",
      );
    }),
  );
  it.effect("caps agent output, always closes it and refuses writes on a writable connection", () =>
    Effect.gen(function* () {
      const database = yield* DatabaseService.DatabaseService;
      const connection = yield* sqliteConnection();
      yield* seedOrders(connection);
      const result = expectKind(
        yield* database.queryReadOnly({
          connectionId: connection.id,
          sql: "SELECT id FROM orders ORDER BY id",
          rowCap: 7,
        }),
        "rows",
      );
      assert.lengthOf(result.rows, 7);
      assert.isTrue(result.hasMore);
      const refused = expectKind(
        yield* database.queryReadOnly({ connectionId: connection.id, sql: "DELETE FROM orders" }),
        "failed",
      );
      assert.match(refused.message, /read.?only/i);
      // The capped read released its lock; an independent write can complete immediately.
      expectKind(
        (yield* run(connection, "UPDATE orders SET note = 'available' WHERE id = 1")).result,
        "command",
      );
      assert.strictEqual(
        (yield* database.queryReadOnly({
          connectionId: connection.id,
          projectId: ProjectId.make("other"),
          sql: "SELECT 1",
        })).kind,
        "rows",
      );
    }),
  );
  it.effect("bounds pages by encoded bytes without dropping wide Unicode rows", () =>
    Effect.gen(function* () {
      const database = yield* DatabaseService.DatabaseService;
      const connection = yield* sqliteConnection();
      yield* seedOrders(connection);
      const { queryId, result } = yield* run(
        connection,
        "SELECT id, printf('%.*c', 3000, '😀') AS note FROM orders ORDER BY id",
        500,
      );
      const first = expectKind(result, "rows");
      assert.isBelow(Buffer.byteLength(JSON.stringify(first)), 1_010_000);
      const ids = first.rows.map((row) => row[0]);
      let hasMore = first.hasMore;
      while (hasMore) {
        const page = yield* database.fetchPage({ queryId, pageSize: 500 });
        assert.isBelow(Buffer.byteLength(JSON.stringify(page)), 1_010_000);
        ids.push(...page.rows.map((row) => row[0]));
        hasMore = page.hasMore;
      }
      assert.deepStrictEqual(
        ids,
        Array.from({ length: 450 }, (_, index) => index + 1),
      );
    }),
  );

  it.effect("keeps unsafe SQLite integers and non-finite numbers as text", () =>
    Effect.gen(function* () {
      const connection = yield* sqliteConnection();
      const result = expectKind(
        (yield* run(connection, "SELECT 9007199254740993, 1e999, NULL, ''")).result,
        "rows",
      );
      assert.deepStrictEqual(result.rows, [["9007199254740993", "Infinity", null, ""]]);
    }),
  );
  it.effect("refuses client-relative SQLite paths", () =>
    Effect.gen(function* () {
      const database = yield* DatabaseService.DatabaseService;
      const result = yield* database.testConnection({
        level: "environment",
        name: "relative",
        target: { engine: "sqlite", path: "shop.sqlite" },
        readOnly: true,
      });
      assert.isFalse(result.ok);
      if (!result.ok) assert.match(result.message, /absolute SQLite file path/);
    }),
  );
});
