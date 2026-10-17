import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { openSqliteSession } from "./sqliteDriver.ts";

const openMemory = () =>
  openSqliteSession({ engine: "sqlite", path: ":memory:" }, false, {
    command: process.execPath,
    entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
  });

it("recovers from evaluation errors in both initial reads and subsequent pages", async () => {
  const session = await openMemory();
  try {
    await expect(session.execute("SELECT abs(-9223372036854775808)", 10)).rejects.toMatchObject({
      engineMessage: "integer overflow",
    });
    const next = await session.execute("SELECT 1", 10);
    expect(next.kind === "rows" && next.firstPage.rows).toEqual([[1]]);
    if (next.kind === "rows") await next.cursor.close();
    const paged = await session.execute(
      "SELECT CASE x WHEN 1 THEN 1 ELSE abs(-9223372036854775808) END FROM (SELECT 1 x UNION ALL SELECT 2)",
      1,
    );
    expect(paged.kind).toBe("rows");
    if (paged.kind === "rows")
      await expect(paged.cursor.read(1)).rejects.toMatchObject({
        engineMessage: "integer overflow",
      });
    const recovered = await session.execute("SELECT 2", 10);
    expect(recovered.kind === "rows" && recovered.firstPage.rows).toEqual([[2]]);
    if (recovered.kind === "rows") await recovered.cursor.close();
  } finally {
    await session.close();
  }
});

it("includes virtual and stored generated columns in table metadata", async () => {
  const session = await openMemory();
  try {
    await session.execute(
      "CREATE TABLE amounts (base INT, doubled INT GENERATED ALWAYS AS (base * 2) STORED, tripled INT GENERATED ALWAYS AS (base * 3) VIRTUAL)",
      10,
    );
    const metadata = await session.introspect({
      kind: "columns",
      schema: "main",
      object: "amounts",
    });
    expect(metadata.kind === "columns" && metadata.columns.map((column) => column.name)).toEqual([
      "base",
      "doubled",
      "tripled",
    ]);
  } finally {
    await session.close();
  }
});

it.effect("terminates a pending SQLite statement and refuses work on the closed process", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const path = `${directory}/cancel.sqlite`;
    yield* fs.writeFileString(path, "");
    const session = yield* Effect.acquireRelease(
      Effect.promise(() =>
        openSqliteSession({ engine: "sqlite", path }, true, {
          command: process.execPath,
          entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
        }),
      ),
      (session) => Effect.promise(() => session.close()),
    );
    yield* Effect.promise(async () => {
      const executing = session.execute(
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 1000000000) SELECT sum(i) FROM n",
        1,
      );
      const cancelled = expect(executing).rejects.toMatchObject({ cancelled: true });
      await session.cancel();
      await cancelled;
      await expect(session.execute("SELECT 1", 1)).rejects.toMatchObject({
        _tag: "DatabaseEngineError",
      });
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
