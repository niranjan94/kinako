import * as NodeSqlite from "node:sqlite";
import type { DatabaseCell, DatabaseIntrospectScope } from "@t3tools/contracts";

const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

function introspect(db: NodeSqlite.DatabaseSync, scope: DatabaseIntrospectScope) {
  switch (scope.kind) {
    case "schemas": {
      const rows = db.prepare("PRAGMA database_list").all() as Array<{ name: string }>;
      return {
        kind: "schemas" as const,
        schemas: rows.filter((row) => row.name !== "temp").map((row) => ({ name: row.name })),
      };
    }
    case "objects": {
      const rows = db
        .prepare(
          `SELECT name, type FROM ${quote(scope.schema)}.sqlite_schema
           WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
           ORDER BY name`,
        )
        .all() as Array<{ name: string; type: "table" | "view" }>;
      return { kind: "objects" as const, objects: rows };
    }
    case "columns": {
      const schema = quote(scope.schema);
      const columns = db
        .prepare(`PRAGMA ${schema}.table_xinfo(${quote(scope.object)})`)
        .all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
        hidden: number;
      }>;
      const foreignKeys = db
        .prepare(`PRAGMA ${schema}.foreign_key_list(${quote(scope.object)})`)
        .all() as Array<{ table: string; from: string; to: string | null }>;
      return {
        kind: "columns" as const,
        columns: columns
          .filter((column) => column.hidden !== 1)
          .map((column) => {
            const reference = foreignKeys.find((key) => key.from === column.name);
            return {
              name: column.name,
              dataType: column.type || "ANY",
              nullable: column.notnull === 0 && column.pk === 0,
              defaultValue: column.dflt_value,
              primaryKey: column.pk > 0,
              references: reference
                ? { schema: scope.schema, object: reference.table, column: reference.to ?? "" }
                : null,
            };
          }),
      };
    }
  }
}

type ProcessRequest = { id: number } & (
  | { method: "open"; args: [{ path: string; readOnly: boolean; textLimit: number }] }
  | { method: "version" | "closeCursor"; args: [] }
  | { method: "introspect"; args: [DatabaseIntrospectScope] }
  | { method: "execute"; args: [string, number] }
  | { method: "read"; args: [number] }
);

export function runSqliteProcess() {
  let db: NodeSqlite.DatabaseSync;
  let cursor: ReturnType<NodeSqlite.StatementSync["iterate"]> | undefined;
  const closeCursor = () => {
    const current = cursor;
    cursor = undefined;
    current?.return?.();
  };
  let textLimit = 2000;
  const cell = (raw: NodeSqlite.SQLOutputValue): DatabaseCell => {
    let value: string | number | null;
    if (typeof raw === "bigint")
      value =
        raw >= BigInt(Number.MIN_SAFE_INTEGER) && raw <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(raw)
          : raw.toString();
    else if (ArrayBuffer.isView(raw))
      value = "\\x" + Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("hex");
    else value = typeof raw === "number" && !Number.isFinite(raw) ? String(raw) : raw;
    return typeof value === "string" && value.length > textLimit
      ? { truncated: value.slice(0, textLimit), length: value.length }
      : value;
  };
  const read = (count: number) => {
    const rows: DatabaseCell[][] = [];
    let weight = 0;
    while (rows.length < count && cursor) {
      const next = cursor.next();
      if (next.done) {
        cursor = undefined;
        return { rows, done: true };
      }
      const row = (next.value as unknown as NodeSqlite.SQLOutputValue[]).map(cell);
      rows.push(row);
      weight += Buffer.byteLength(JSON.stringify(row));
      if (weight >= 900000) break;
    }
    return { rows, done: cursor === undefined };
  };
  process.on("disconnect", () => process.exit(0));
  process.on("message", (message: ProcessRequest) => {
    const previousCursor = cursor;
    try {
      let value: unknown;
      switch (message.method) {
        case "open": {
          const target = message.args[0];
          db = new NodeSqlite.DatabaseSync(target.path, { readOnly: target.readOnly });
          textLimit = target.textLimit;
          break;
        }
        case "version":
          value = db.prepare("SELECT sqlite_version() AS version").get()?.version;
          break;
        case "introspect":
          value = introspect(db, message.args[0]);
          break;
        case "execute": {
          if (cursor)
            throw new Error("Close the previous result before running another statement.");
          const [sql, count] = message.args;
          const statement = db.prepare(sql);
          statement.setReadBigInts(true);
          const columns = statement.columns();
          if (columns.length === 0) {
            const result = statement.run();
            value = {
              kind: "command",
              command: sql.trim().split(/\s+/, 1)[0]?.toUpperCase() ?? "OK",
              affectedRows: Number(result.changes),
            };
          } else {
            statement.setReturnArrays(true);
            cursor = statement.iterate();
            value = {
              kind: "rows",
              columns: columns.map((column) => ({
                name: column.name,
                dataType: column.type ?? "",
              })),
              firstPage: read(count),
            };
          }
          break;
        }
        case "read":
          value = read(message.args[0]);
          break;
        case "closeCursor":
          closeCursor();
          break;
      }
      process.send?.({ id: message.id, ok: true, value });
    } catch (cause) {
      if ((message.method === "execute" && !previousCursor) || message.method === "read") {
        try {
          closeCursor();
        } catch {
          // Keep the original evaluation error even if finalizing the iterator also fails.
        }
      }
      process.send?.({
        id: message.id,
        ok: false,
        message: cause instanceof Error ? cause.message : "SQLite request failed.",
        code:
          typeof cause === "object" &&
          cause !== null &&
          "code" in cause &&
          typeof cause.code === "string"
            ? cause.code
            : null,
      });
    }
  });
}
