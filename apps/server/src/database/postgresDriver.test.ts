import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import type { DatabasePostgresTarget } from "@t3tools/contracts";
import pg from "pg";
import { openPostgresSession } from "./postgresDriver.ts";
import type { DatabaseSession } from "./databaseDriver.ts";

const port = process.env.T3_TEST_POSTGRES_PORT;
const database = `kinako_issue15_${process.pid}`;
const config = {
  host: "127.0.0.1",
  port: Number(port),
  user: "postgres",
  password: "kinako-issue15-test",
};
const target: DatabasePostgresTarget = {
  engine: "postgres",
  ...config,
  database,
  sslMode: "disable",
};

describe.skipIf(port === undefined)("Postgres database adapter", () => {
  let admin: pg.Client;
  const sessions: DatabaseSession[] = [];
  beforeAll(async () => {
    admin = new pg.Client({ ...config, database: "postgres" });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${database}`);
  });
  afterAll(async () => {
    await Promise.all(sessions.map((session) => session.close()));
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.end();
  });
  const open = async (readOnly = false) => {
    const session = await openPostgresSession(target, config.password, readOnly);
    sessions.push(session);
    return session;
  };
  it("keeps exact numerics, timestamps, json and duplicate column names while paging", async () => {
    const session = await open();
    const outcome = await session.execute(
      "SELECT 9007199254740993::int8 AS value, 12345678901234567890.123456789::numeric AS value, timestamp '2026-01-01 12:34:56.123456' AS time, '{\"large\":9007199254740993}'::jsonb AS data, true AS enabled FROM generate_series(1, 3)",
      2,
    );
    expect(outcome.kind).toBe("rows");
    if (outcome.kind !== "rows") return;
    try {
      expect(outcome.cursor.columns.slice(0, 2).map((column) => column.name)).toEqual([
        "value",
        "value",
      ]);
      expect(outcome.firstPage.rows[0]).toEqual([
        "9007199254740993",
        "12345678901234567890.123456789",
        "2026-01-01 12:34:56.123456",
        '{"large": 9007199254740993}',
        true,
      ]);
      expect(outcome.firstPage.done).toBe(false);
      const page = await outcome.cursor.read(2);
      expect(page.rows).toHaveLength(1);
      expect(page.done).toBe(true);
    } finally {
      await outcome.cursor.close();
    }
  });
  it("reports a refused login as an engine error", async () => {
    await expect(openPostgresSession(target, "incorrect-password", true)).rejects.toMatchObject({
      _tag: "DatabaseEngineError",
      code: "28P01",
    });
  });
  it("reports the active session search path in resolution order", async () => {
    const session = await open();
    await session.execute("CREATE SCHEMA completion_tenant", 10);
    await session.execute("SET search_path TO completion_tenant, public", 10);
    const metadata = await session.introspect({ kind: "schemas" });
    expect(metadata.kind === "schemas" && metadata.searchPath).toEqual([
      "completion_tenant",
      "public",
    ]);
  });
  it("retains temp tables and settings between statements", async () => {
    const session = await open();
    expect((await session.execute("SET search_path TO pg_temp", 10)).kind).toBe("command");
    expect((await session.execute("CREATE TEMP TABLE scratch (id integer)", 10)).kind).toBe(
      "command",
    );
    expect((await session.execute("INSERT INTO scratch VALUES (42)", 10)).kind).toBe("command");
    const outcome = await session.execute("SELECT id FROM scratch", 10);
    expect(outcome.kind).toBe("rows");
    if (outcome.kind === "rows") {
      expect(outcome.firstPage.rows).toEqual([[42]]);
      await outcome.cursor.close();
    }
  });
  it("reports SQLSTATE, refuses writes in read-only sessions and cancels a running statement", async () => {
    const readonly = await open(true);
    await expect(
      readonly.execute("CREATE TABLE should_fail (id integer)", 10),
    ).rejects.toMatchObject({ code: "25006" });
    await expect(readonly.execute("SELECT does_not_exist", 10)).rejects.toMatchObject({
      code: "42703",
      position: 8,
    });
    const session = await open();
    const warmed = await session.execute("SELECT 1", 10);
    if (warmed.kind === "rows") await warmed.cursor.close();
    await session.execute("CREATE TEMP TABLE retained_after_cancel (id integer)", 10);
    const executing = session.execute("SELECT pg_sleep(30)", 1);
    const cancelled = executing.then(
      () => null,
      (error: unknown) => error,
    );
    await session.cancel();
    expect(await cancelled).toMatchObject({ cancelled: true, code: "57014" });
    const retained = await session.execute("SELECT * FROM retained_after_cancel", 10);
    expect(retained.kind).toBe("rows");
    if (retained.kind === "rows") await retained.cursor.close();
  });
});
