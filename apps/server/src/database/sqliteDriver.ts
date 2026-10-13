import type { DatabaseIntrospectScope, DatabaseSqliteTarget } from "@t3tools/contracts";
import * as NodeSqlite from "node:sqlite";

import {
  DatabaseEngineError,
  isDatabaseEngineError,
  toCell,
  type DatabaseSession,
} from "./databaseDriver.ts";

function engineError(cause: unknown): DatabaseEngineError {
  if (isDatabaseEngineError(cause)) return cause;
  const record = (typeof cause === "object" && cause !== null ? cause : {}) as {
    readonly message?: unknown;
    readonly errcode?: unknown;
  };
  return new DatabaseEngineError({
    engineMessage: typeof record.message === "string" ? record.message : "Unknown database error.",
    code: typeof record.errcode === "number" ? String(record.errcode) : null,
    position: null,
    cancelled: false,
    cause,
  });
}

/** SQLite hands back bigints and blobs; the grid gets their text form. */
function cellValue(value: NodeSqlite.SQLInputValue): string | number | boolean | null {
  if (value === null || typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  return `\\x${Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("hex")}`;
}

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
          .filter((column) => column.hidden === 0)
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

/**
 * Opens the file for one statement. The caller checks the file exists first: DatabaseSync creates
 * missing files, which would turn a typo into an empty database. node:sqlite is synchronous, so a statement that scans a huge
 * table blocks the server while it runs; reads are paged to keep each step short, but nothing
 * can interrupt a single slow step.
 */
export async function openSqliteSession(
  target: DatabaseSqliteTarget,
  readOnly: boolean,
): Promise<DatabaseSession> {
  let db: NodeSqlite.DatabaseSync;
  try {
    db = new NodeSqlite.DatabaseSync(target.path, { readOnly });
  } catch (cause) {
    throw engineError(cause);
  }

  const readPage = (iterator: Iterator<unknown>, count: number) => {
    const rows = [];
    while (rows.length < count) {
      const next = iterator.next();
      if (next.done) return { rows, done: true };
      rows.push(
        (next.value as ReadonlyArray<NodeSqlite.SQLInputValue>).map((value) =>
          toCell(cellValue(value)),
        ),
      );
    }
    return { rows, done: false };
  };

  return {
    serverVersion: async () => {
      try {
        const row = db.prepare("SELECT sqlite_version() AS version").get() as { version: string };
        return row.version;
      } catch (cause) {
        throw engineError(cause);
      }
    },
    introspect: async (scope) => {
      try {
        return introspect(db, scope);
      } catch (cause) {
        throw engineError(cause);
      }
    },
    execute: async (sql, pageSize) => {
      let statement: NodeSqlite.StatementSync;
      try {
        statement = db.prepare(sql);
        const columns = statement.columns();
        if (columns.length === 0) {
          const result = statement.run();
          return {
            kind: "command",
            command: sql.trim().split(/\s+/, 1)[0]?.toUpperCase() ?? "OK",
            affectedRows: Number(result.changes),
          };
        }
        statement.setReturnArrays(true);
        const iterator = statement.iterate();
        const firstPage = readPage(iterator, pageSize);
        return {
          kind: "rows",
          firstPage,
          cursor: {
            columns: columns.map((column) => ({
              name: column.name,
              dataType: column.type ?? "",
            })),
            read: async (count) => {
              try {
                return readPage(iterator, count);
              } catch (cause) {
                throw engineError(cause);
              }
            },
            close: async () => {
              iterator.return?.();
            },
          },
        };
      } catch (cause) {
        throw engineError(cause);
      }
    },
    cancel: async () => {},
    close: async () => {
      if (db.isOpen) db.close();
    },
  };
}
