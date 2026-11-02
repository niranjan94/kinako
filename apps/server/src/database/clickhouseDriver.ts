// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Engine adapters sit behind the Promise-based DatabaseSession, like the Postgres and SQLite drivers.
import * as NodeCrypto from "node:crypto";

import type { DatabaseClickhouseTarget, DatabaseIntrospectScope } from "@t3tools/contracts";

import {
  DatabaseEngineError,
  isDatabaseEngineError,
  toCell,
  type DatabasePage,
  type DatabaseSession,
} from "./databaseDriver.ts";

const CONNECT_TIMEOUT_MS = 10_000;
const FORMAT = "JSONCompactEachRowWithNamesAndTypes";

type Value = string | number | boolean | null;

function engineError(cause: unknown, cancelled = false): DatabaseEngineError {
  if (isDatabaseEngineError(cause)) return cause;
  const aborted = cause instanceof Error && cause.name === "AbortError";
  return new DatabaseEngineError({
    engineMessage: aborted
      ? "Query cancelled."
      : cause instanceof Error
        ? cause.message
        : "Unknown database error.",
    code: null,
    position: null,
    cancelled: cancelled || aborted,
    cause,
  });
}

function rejected(message: string, code: string | null = null): DatabaseEngineError {
  return new DatabaseEngineError({
    engineMessage: message.trim() || "ClickHouse rejected the request.",
    code,
    position: null,
    cancelled: false,
  });
}

/** Arrays, maps and tuples arrive as JSON; the grid shows them as their JSON text. */
const cell = (value: unknown) =>
  toCell(
    value === null || ["string", "number", "boolean"].includes(typeof value)
      ? (value as Value)
      : JSON.stringify(value),
  );

/** Splits a streamed response into lines, pulling from the network only when asked. */
function lineReader(body: ReadableStream<Uint8Array>) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let ended = false;
  return {
    next: async (): Promise<string | null> => {
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.trim()) return line;
          continue;
        }
        if (ended) {
          const rest = buffer;
          buffer = "";
          return rest.trim() ? rest : null;
        }
        const chunk = await reader.read();
        if (chunk.done) ended = true;
        else buffer += chunk.value;
      }
    },
    cancel: () => reader.cancel().catch(() => {}),
  };
}

const EXCEPTION = /^Code: (\d+)\. DB::Exception/;

/**
 * ClickHouse writes a failure into the output format, even after rows have streamed: here as a
 * one-element array holding the exception text.
 */
function parseRow(line: string): ReadonlyArray<unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw rejected(line, EXCEPTION.exec(line)?.[1] ?? null);
  }
  if (!Array.isArray(parsed)) throw rejected(line);
  const [only] = parsed;
  if (parsed.length === 1 && typeof only === "string" && EXCEPTION.test(only))
    throw rejected(only, EXCEPTION.exec(only)?.[1] ?? null);
  return parsed;
}

/** The exception line of a failed response, without the format's header lines around it. */
function failureText(body: string): string {
  const last = body.trim().split("\n").at(-1) ?? "";
  try {
    const parsed: unknown = JSON.parse(last);
    if (Array.isArray(parsed) && typeof parsed[0] === "string") return parsed[0];
  } catch {}
  return body;
}

export async function openClickhouseSession(
  target: DatabaseClickhouseTarget,
  password: string | null,
  readOnly: boolean,
): Promise<DatabaseSession> {
  const host = target.host.replace(/^[a-z]+:\/\//i, "").replace(/\/+$/, "");
  const endpoint = `${target.secure ? "https" : "http"}://${host}:${target.port}/`;
  let sessionId = NodeCrypto.randomUUID();
  const headers = {
    "X-ClickHouse-User": target.user,
    ...(password === null ? {} : { "X-ClickHouse-Key": password }),
  };
  let running: { readonly id: string; readonly abort: AbortController } | undefined;
  let cancelled = false;

  const post = async (
    sql: string,
    options: {
      readonly params?: Record<string, string>;
      readonly session?: boolean;
      readonly queryId?: string;
      readonly signal?: AbortSignal;
    } = {},
  ) => {
    const url = new URL(endpoint);
    url.searchParams.set("database", target.database);
    url.searchParams.set("default_format", FORMAT);
    // A guard against accidents, not a security boundary.
    if (readOnly) url.searchParams.set("readonly", "1");
    if (options.session) url.searchParams.set("session_id", sessionId);
    if (options.queryId) url.searchParams.set("query_id", options.queryId);
    for (const [name, value] of Object.entries(options.params ?? {}))
      url.searchParams.set(`param_${name}`, value);
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: sql,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw rejected(failureText(text), response.headers.get("X-ClickHouse-Exception-Code"));
    }
    return response;
  };

  /** Small metadata reads: the whole result as rows of values. */
  const rows = async (sql: string, params?: Record<string, string>) => {
    const text = await (
      await post(sql, { ...(params ? { params } : {}), signal: AbortSignal.timeout(30_000) })
    ).text();
    return text
      .split("\n")
      .filter((line) => line.trim())
      .slice(2)
      .map(parseRow);
  };

  const introspect = async (scope: DatabaseIntrospectScope) => {
    switch (scope.kind) {
      case "databases":
        return { kind: "databases" as const, databases: [] };
      case "schemas": {
        const result = await rows(
          "SELECT name FROM system.databases WHERE name NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema') ORDER BY name",
        );
        return {
          kind: "schemas" as const,
          schemas: result.map(([name]) => ({ name: String(name) })),
          searchPath: [target.database],
        };
      }
      case "objects": {
        const result = await rows(
          "SELECT name, engine FROM system.tables WHERE database = {db:String} ORDER BY name",
          { db: scope.schema },
        );
        return {
          kind: "objects" as const,
          objects: result.map(([name, engine]) => ({
            name: String(name),
            type:
              engine === "View"
                ? ("view" as const)
                : engine === "MaterializedView"
                  ? ("materialized-view" as const)
                  : ("table" as const),
          })),
        };
      }
      case "columns": {
        const result = await rows(
          `SELECT name, type, default_expression, is_in_primary_key
           FROM system.columns WHERE database = {db:String} AND table = {table:String}
           ORDER BY position`,
          { db: scope.schema, table: scope.object },
        );
        return {
          kind: "columns" as const,
          columns: result.map(([name, type, defaultValue, primaryKey]) => ({
            name: String(name),
            dataType: String(type),
            nullable: String(type).startsWith("Nullable("),
            defaultValue: defaultValue ? String(defaultValue) : null,
            primaryKey: primaryKey === 1 || primaryKey === "1" || primaryKey === true,
            references: null,
          })),
        };
      }
    }
  };

  // Fails fast on a wrong host, port, or password instead of at the first query.
  await post("SELECT 1", { signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) })
    .then((response) => response.text())
    .catch((cause) => {
      throw engineError(cause);
    });

  return {
    cancelClosesSession: true,
    serverVersion: async () => {
      try {
        const [row] = await rows("SELECT version()");
        return String(row?.[0] ?? "unknown");
      } catch (cause) {
        throw engineError(cause);
      }
    },
    introspect: async (scope) => {
      try {
        return await introspect(scope);
      } catch (cause) {
        throw engineError(cause);
      }
    },
    execute: async (sql, pageSize) => {
      cancelled = false;
      const query = { id: NodeCrypto.randomUUID(), abort: new AbortController() };
      running = query;
      try {
        const response = await post(sql, {
          session: true,
          queryId: query.id,
          signal: query.abort.signal,
        });
        const summary = response.headers.get("X-ClickHouse-Summary");
        if (!response.body) throw rejected("ClickHouse returned no response.");
        const lines = lineReader(response.body);
        const namesLine = await lines.next();
        if (namesLine === null) {
          let affectedRows: number | null = null;
          try {
            const written = Number(JSON.parse(summary ?? "{}").written_rows);
            if (Number.isFinite(written)) affectedRows = written;
          } catch {}
          return { kind: "command", command: "OK", affectedRows };
        }
        const names = parseRow(namesLine);
        const typesLine = await lines.next();
        const types = typesLine === null ? [] : parseRow(typesLine);
        const read = async (count: number): Promise<DatabasePage> => {
          const page = [];
          while (page.length < count) {
            const line = await lines.next();
            if (line === null) return { rows: page, done: true };
            page.push(parseRow(line).map(cell));
          }
          return { rows: page, done: false };
        };
        return {
          kind: "rows",
          firstPage: await read(pageSize),
          cursor: {
            columns: names.map((name, index) => ({
              name: String(name),
              dataType: String(types[index] ?? ""),
            })),
            read: async (count) => {
              try {
                return await read(count);
              } catch (cause) {
                throw engineError(cause, cancelled);
              }
            },
            close: async () => {
              await lines.cancel();
              if (running === query) running = undefined;
            },
          },
        };
      } catch (cause) {
        if (running === query) running = undefined;
        throw engineError(cause, cancelled);
      }
    },
    cancel: async () => {
      const query = running;
      if (!query) return;
      cancelled = true;
      query.abort.abort();
      // The killed query keeps its session locked for a while; SET state is lost either way.
      sessionId = NodeCrypto.randomUUID();
      await post("KILL QUERY WHERE query_id = {id:String} ASYNC", {
        params: { id: query.id },
        signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
      })
        .then((response) => response.text())
        .catch(() => {});
    },
    close: async () => {
      running?.abort.abort();
      running = undefined;
    },
  };
}
