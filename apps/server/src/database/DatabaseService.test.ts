import {
  DATABASE_CELL_TEXT_MAX,
  DatabaseQueryId,
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
        name: "prod",
        target,
        readOnly: true,
        password: "hunter2",
      });
      assert.isTrue(saved.hasPassword);
      assert.notInclude(JSON.stringify(yield* database.listConnections()), "hunter2");

      const renamed = yield* database.saveConnection({
        id: saved.id,
        name: "production",
        target,
        readOnly: true,
      });
      assert.strictEqual(renamed.name, "production");
      assert.isTrue(renamed.hasPassword, "an omitted password keeps the stored one");
      assert.strictEqual(renamed.createdAt, saved.createdAt);

      const cleared = yield* database.saveConnection({
        id: saved.id,
        name: "production",
        target,
        readOnly: true,
        password: null,
      });
      assert.isFalse(cleared.hasPassword);

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
        name: "typo",
        target: { engine: "sqlite", path },
        readOnly: false,
      });
      const missing = expectKind((yield* run(connection, "SELECT 1")).result, "failed");
      assert.include(missing.message, "No SQLite database");
      assert.isFalse(yield* fileSystem.exists(path));

      const tested = yield* database.testConnection({
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
});
