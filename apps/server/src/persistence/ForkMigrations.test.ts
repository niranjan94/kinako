import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  FORK_MIGRATIONS_TABLE,
  forkMigrationManifest,
  runForkMigrations,
} from "./ForkMigrations.ts";
import { migrationManifest, runMigrations } from "./Migrations.ts";
import AdditionalDirectories from "./Migrations/fork/001_ProjectionProjectsAdditionalDirectories.ts";
import DatabaseConnections from "./Migrations/fork/002_DatabaseConnections.ts";

const ledgers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const read = (table: string) =>
    sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name FROM ${sql(table)} ORDER BY migration_id
    `.pipe(Effect.map((rows) => rows.map((row) => [row.migration_id, row.name] as const)));
  return {
    upstream: yield* read("effect_sql_migrations"),
    fork: yield* read(FORK_MIGRATIONS_TABLE),
  };
});

const upstreamAfter = (id: number) => migrationManifest.filter(([entryId]) => entryId > id);

// The latest upstream migration when each fork migration was added: the earliest point an
// existing database can have run it. Add an entry with every new fork migration.
const firstRanAfterUpstream: Readonly<Record<number, number>> = { 1: 62, 2: 62, 3: 64 };

const schema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const objects = yield* sql<{ readonly type: string; readonly name: string }>`
    SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name
  `;
  const columns = yield* sql<{ readonly tableName: string; readonly columnName: string }>`
    SELECT m.name AS tableName, p.name AS columnName
    FROM sqlite_master m, pragma_table_info(m.name) p
    WHERE m.type = 'table'
    ORDER BY m.name, p.name
  `;
  return { objects, columns };
});

describe("fork migration ledger", () => {
  it.effect("keeps upstream ids in the upstream ledger and fork ids in the fork ledger", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      assert.deepStrictEqual(yield* ledgers, {
        upstream: migrationManifest,
        fork: forkMigrationManifest,
      });
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("splits a fork-era shared ledger without rerunning any migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`DROP TABLE ${sql(FORK_MIGRATIONS_TABLE)}`;
      for (const [from, to] of [
        [69, 72],
        [68, 71],
        [67, 70],
        [66, 69],
        [65, 68],
        [64, 66],
        [63, 65],
      ]) {
        yield* sql`UPDATE effect_sql_migrations SET migration_id = ${to} WHERE migration_id = ${from}`;
      }
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES
          (63, 'ProjectionProjectsAdditionalDirectories'),
          (64, 'DatabaseConnections'),
          (67, 'SnoozeWakeIndex')
      `;

      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* ledgers, {
        upstream: migrationManifest,
        fork: forkMigrationManifest,
      });
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("runs what a partial fork-era ledger is missing from both ledgers", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 62 });
      yield* AdditionalDirectories;
      yield* DatabaseConnections;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES
          (63, 'ProjectionProjectsAdditionalDirectories'),
          (64, 'DatabaseConnections')
      `;

      assert.deepStrictEqual(yield* runMigrations(), upstreamAfter(62));
      assert.deepStrictEqual(yield* ledgers, {
        upstream: migrationManifest,
        fork: forkMigrationManifest,
      });
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("keeps fork schema when later upstream migrations run over it", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        forkMigrationManifest.filter(([id]) => firstRanAfterUpstream[id] === undefined),
        [],
      );
      const fresh = yield* runMigrations().pipe(
        Effect.andThen(schema),
        Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
      );
      const upgraded = yield* Effect.gen(function* () {
        for (const [id] of forkMigrationManifest) {
          yield* runMigrations({ toMigrationInclusive: firstRanAfterUpstream[id] });
          yield* runForkMigrations({ toMigrationInclusive: id });
        }
        yield* runMigrations();
        return yield* schema;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));
      assert.deepStrictEqual(upgraded, fresh);
    }),
  );
});
