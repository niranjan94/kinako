import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import ForkMigration0001 from "./Migrations/fork/001_ProjectionProjectsAdditionalDirectories.ts";
import ForkMigration0002 from "./Migrations/fork/002_DatabaseConnections.ts";
import ForkMigration0003 from "./Migrations/fork/003_SnoozeWakeIndex.ts";

// Fork-only migrations keep their own ledger so upstream migrations keep upstream's ids.
// They run after every upstream migration, so they may depend on upstream's latest schema.
export const FORK_MIGRATIONS_TABLE = "fork_sql_migrations";

const forkMigrationEntries = [
  [1, "ProjectionProjectsAdditionalDirectories", ForkMigration0001],
  [2, "DatabaseConnections", ForkMigration0002],
  [3, "SnoozeWakeIndex", ForkMigration0003],
] as const;

export const forkMigrationManifest = forkMigrationEntries.map(([id, name]) => [id, name] as const);

// Frozen: the fork-era shared ledger interleaved these with upstream's, which shifted upstream ids.
const FORK_ERA_FORK_IDS: ReadonlyMap<string, number> = new Map([
  ["ProjectionProjectsAdditionalDirectories", 1],
  ["DatabaseConnections", 2],
  ["SnoozeWakeIndex", 3],
]);
const FORK_ERA_UPSTREAM_IDS: ReadonlyMap<string, number> = new Map([
  ["DropUnusedV1Projections", 63],
  ["CanonicalizeThreadPullRequestLinks", 64],
  ["CodexUsageNativeTurnIndex", 65],
  ["RepairClientSettlementTimestamps", 66],
  ["WebhookDedupe", 67],
  ["ShellStopRequestIndex", 68],
  ["ThreadMessageSearch", 69],
]);

/** Moves fork rows out of a fork-era shared ledger and restores upstream's ids for the rest. */
export const splitForkMigrationLedger = Effect.fn("splitForkMigrationLedger")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
      if (tables.length === 0) return;
      const recorded = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
        readonly created_at: string;
      }>`SELECT migration_id, name, created_at FROM effect_sql_migrations`;
      const forkRows = recorded.flatMap((row) => {
        const forkId = FORK_ERA_FORK_IDS.get(row.name);
        return forkId === undefined ? [] : [{ ...row, forkId }];
      });
      if (forkRows.length === 0) return;

      yield* sql`
        CREATE TABLE IF NOT EXISTS ${sql(FORK_MIGRATIONS_TABLE)} (
          migration_id integer PRIMARY KEY NOT NULL,
          created_at datetime NOT NULL DEFAULT current_timestamp,
          name VARCHAR(255) NOT NULL
        )
      `;
      for (const row of forkRows) {
        yield* sql`
          INSERT INTO ${sql(FORK_MIGRATIONS_TABLE)} (migration_id, name, created_at)
          VALUES (${row.forkId}, ${row.name}, ${row.created_at})
        `;
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = ${row.migration_id}`;
      }

      const moved = recorded.flatMap((row) => {
        const upstreamId = FORK_ERA_UPSTREAM_IDS.get(row.name);
        return upstreamId === undefined || upstreamId === row.migration_id
          ? []
          : [{ from: row.migration_id, to: upstreamId }];
      });
      // Park on negative ids first so no renumbering order can collide on the primary key.
      for (const { from, to } of moved) {
        yield* sql`UPDATE effect_sql_migrations SET migration_id = ${-to} WHERE migration_id = ${from}`;
      }
      for (const { to } of moved) {
        yield* sql`UPDATE effect_sql_migrations SET migration_id = ${to} WHERE migration_id = ${-to}`;
      }
      yield* Effect.log("Split fork migrations into their own ledger").pipe(
        Effect.annotateLogs({ forkMigrations: forkRows.map((row) => row.name) }),
      );
    }),
  );
});

const run = Migrator.make({});

export const runForkMigrations = Effect.fn("runForkMigrations")(function* () {
  const executed = yield* run({
    loader: Migrator.fromRecord(
      Object.fromEntries(
        forkMigrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
    table: FORK_MIGRATIONS_TABLE,
  });
  if (executed.length > 0) {
    yield* Effect.log("Fork migrations ran successfully").pipe(
      Effect.annotateLogs({ migrations: executed.map(([id, name]) => `${id}_${name}`) }),
    );
  }
  return executed;
});
