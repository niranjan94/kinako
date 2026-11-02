// @effect-diagnostics nodeBuiltinImport:off - A local HTTP server stands in for ClickHouse.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import { expect, it } from "@effect/vitest";

import { openClickhouseSession } from "./clickhouseDriver.ts";

const HEADER = '["id", "tags"]\n["UInt64", "Array(String)"]\n';

async function fakeClickhouse() {
  const requests: Array<{ url: URL; sql: string; user: string | undefined }> = [];
  const server = NodeHttp.createServer((request, response) => {
    let sql = "";
    request.on("data", (chunk) => (sql += chunk));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      requests.push({ url, sql, user: request.headers["x-clickhouse-user"] as string });
      if (sql === "SELECT 1") return response.end('["1"]\n["UInt8"]\n[1]\n');
      if (sql.startsWith("INSERT")) {
        response.setHeader("X-ClickHouse-Summary", '{"written_rows":"3"}');
        return response.end();
      }
      if (sql === "SELECT broken") {
        response.statusCode = 404;
        response.setHeader("X-ClickHouse-Exception-Code", "47");
        return response.end('[]\n[]\n["Code: 47. DB::Exception: Unknown identifier"]\n');
      }
      // Rows split mid-line across writes, then an exception after the 200 status.
      response.write(HEADER + '["18446744073709551615", ["a"]]\n["2",');
      response.write(' []]\n["3", ["c"]]\n');
      response.end(
        sql === "SELECT fails" ? '["Code: 241. DB::Exception: Memory limit exceeded"]\n' : "",
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as NodeNet.AddressInfo).port;
  const open = () =>
    openClickhouseSession(
      {
        engine: "clickhouse",
        host: "http://127.0.0.1/",
        port,
        database: "db",
        user: "reader",
        secure: false,
      },
      "pw",
      true,
    );
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { requests, open, close };
}

async function withFake(test: (fake: Awaited<ReturnType<typeof fakeClickhouse>>) => Promise<void>) {
  const fake = await fakeClickhouse();
  try {
    await test(fake);
  } finally {
    await fake.close();
  }
}

it("pages streamed rows and keeps 64-bit integers and arrays exact", () =>
  withFake(async (fake) => {
    const session = await fake.open();
    const outcome = await session.execute("SELECT * FROM t", 2);
    expect(outcome.kind).toBe("rows");
    if (outcome.kind !== "rows") return;
    expect(outcome.cursor.columns).toEqual([
      { name: "id", dataType: "UInt64" },
      { name: "tags", dataType: "Array(String)" },
    ]);
    expect(outcome.firstPage).toEqual({
      rows: [
        ["18446744073709551615", '["a"]'],
        ["2", "[]"],
      ],
      done: false,
    });
    expect(await outcome.cursor.read(5)).toEqual({ rows: [["3", '["c"]']], done: true });
    await outcome.cursor.close();
    const query = fake.requests.at(-1)!;
    expect(query.user).toBe("reader");
    expect(query.url.searchParams.get("readonly")).toBe("1");
    expect(query.url.searchParams.get("database")).toBe("db");
    expect(query.url.searchParams.get("session_id")).toBeTruthy();
  }));

it("reports errors before and during the stream, and row counts for commands", () =>
  withFake(async (fake) => {
    const session = await fake.open();
    await expect(session.execute("SELECT broken", 10)).rejects.toMatchObject({
      engineMessage: "Code: 47. DB::Exception: Unknown identifier",
      code: "47",
    });
    const failing = await session.execute("SELECT fails", 1);
    if (failing.kind !== "rows") throw new Error("expected rows");
    await expect(failing.cursor.read(10)).rejects.toMatchObject({
      engineMessage: "Code: 241. DB::Exception: Memory limit exceeded",
      code: "241",
    });
    expect(await session.execute("INSERT INTO t VALUES (1)", 10)).toEqual({
      kind: "command",
      command: "OK",
      affectedRows: 3,
    });
  }));
