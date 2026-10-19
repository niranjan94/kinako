import type { DatabaseIntrospectScope, DatabasePostgresTarget } from "@t3tools/contracts";
import pg from "pg";
import { FORK_DISPLAY_NAME } from "@t3tools/shared/forkBrand";
import Cursor from "pg-cursor";

import {
  DatabaseEngineError,
  isDatabaseEngineError,
  toCell,
  type DatabasePage,
  type DatabaseSession,
} from "./databaseDriver.ts";
import { resolvePostgresLogin, type PostgresLogin } from "./postgresLogin.ts";

const BOOL_OID = 16;
const NUMBER_OIDS = new Set([21, 23, 26, 700, 701]); // int2, int4, oid, float4, float8
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Every value arrives as the text Postgres printed, so int8, numeric and timestamps keep their
 * exact form. Only booleans and the number types that fit a double become JSON values.
 */
const types: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number) => {
    if (oid === BOOL_OID) return (value: string) => value === "t";
    if (NUMBER_OIDS.has(oid)) {
      return (value: string) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : value;
      };
    }
    return (value: string) => value;
  }) as pg.CustomTypesConfig["getTypeParser"],
};

function sslOptions(mode: DatabasePostgresTarget["sslMode"]): pg.ClientConfig["ssl"] {
  switch (mode) {
    case "disable":
      return false;
    case "prefer":
    case "require":
      return { rejectUnauthorized: false };
    case "verify-full":
      return { rejectUnauthorized: true };
  }
}

function engineError(cause: unknown, cancelled = false): DatabaseEngineError {
  if (isDatabaseEngineError(cause)) return cause;
  const record = (typeof cause === "object" && cause !== null ? cause : {}) as {
    readonly message?: unknown;
    readonly code?: unknown;
    readonly position?: unknown;
  };
  const code = typeof record.code === "string" ? record.code : null;
  const position = typeof record.position === "string" ? Number(record.position) : NaN;
  return new DatabaseEngineError({
    engineMessage: typeof record.message === "string" ? record.message : "Unknown database error.",
    code,
    position: Number.isInteger(position) && position > 0 ? position : null,
    // 57014 is query_canceled, which is what pg_cancel_backend produces.
    cancelled: cancelled || code === "57014",
    cause,
  });
}

async function connect(
  target: DatabasePostgresTarget,
  login: PostgresLogin,
  ssl: pg.ClientConfig["ssl"],
): Promise<pg.Client> {
  const client = new pg.Client({
    host: login.host,
    port: login.port,
    database: target.database,
    user: login.user,
    ...(login.password === null ? {} : { password: login.password }),
    ssl,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    application_name: FORK_DISPLAY_NAME,
    types,
  });
  // A dropped socket emits "error" on the client; unhandled, it would take down the server.
  client.on("error", () => {});
  try {
    await client.connect();
    return client;
  } catch (cause) {
    await client.end().catch(() => {});
    throw cause;
  }
}

async function connectWithSslMode(
  target: DatabasePostgresTarget,
  login: PostgresLogin,
): Promise<pg.Client> {
  try {
    return await connect(target, login, sslOptions(target.sslMode));
  } catch (cause) {
    // "prefer" is libpq's default: try TLS, fall back to plain when the server has none.
    if (target.sslMode === "prefer" && /does not support SSL/i.test(String(cause))) {
      return connect(target, login, false);
    }
    throw cause;
  }
}

const COLUMNS_SQL = `
  SELECT
    a.attname AS name,
    format_type(a.atttypid, a.atttypmod) AS data_type,
    NOT a.attnotnull AS nullable,
    pg_get_expr(d.adbin, d.adrelid) AS default_value,
    EXISTS (
      SELECT 1 FROM pg_index i
      WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY (i.indkey)
    ) AS primary_key,
    (
      SELECT json_build_object('schema', fn.nspname, 'object', fc.relname, 'column', fa.attname)
      FROM pg_constraint k
      JOIN pg_class fc ON fc.oid = k.confrelid
      JOIN pg_namespace fn ON fn.oid = fc.relnamespace
      JOIN pg_attribute fa
        ON fa.attrelid = k.confrelid AND fa.attnum = k.confkey[array_position(k.conkey, a.attnum)]
      WHERE k.conrelid = c.oid AND k.contype = 'f' AND a.attnum = ANY (k.conkey)
      LIMIT 1
    )::text AS reference
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
  WHERE n.nspname = $1 AND c.relname = $2
  ORDER BY a.attnum
`;

const RELKIND_TYPES = {
  r: "table",
  p: "table",
  f: "table",
  v: "view",
  m: "materialized-view",
} as const;

async function introspect(client: pg.Client, scope: DatabaseIntrospectScope) {
  switch (scope.kind) {
    case "schemas": {
      const result = await client.query<{ name: string }>(
        `SELECT nspname AS name FROM pg_namespace
         WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'
         ORDER BY nspname`,
      );
      const searchPath = await client.query<{ name: string }>(
        "SELECT unnest(current_schemas(false)) AS name",
      );
      return {
        kind: "schemas" as const,
        schemas: result.rows,
        searchPath: searchPath.rows.map((row) => row.name),
      };
    }
    case "objects": {
      const result = await client.query<{ name: string; kind: keyof typeof RELKIND_TYPES }>(
        `SELECT c.relname AS name, c.relkind AS kind
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'f', 'v', 'm')
         ORDER BY c.relname`,
        [scope.schema],
      );
      return {
        kind: "objects" as const,
        objects: result.rows.map((row) => ({ name: row.name, type: RELKIND_TYPES[row.kind] })),
      };
    }
    case "columns": {
      const result = await client.query<{
        name: string;
        data_type: string;
        nullable: boolean;
        default_value: string | null;
        primary_key: boolean;
        reference: string | null;
      }>(COLUMNS_SQL, [scope.schema, scope.object]);
      return {
        kind: "columns" as const,
        columns: result.rows.map((row) => ({
          name: row.name,
          dataType: row.data_type,
          nullable: row.nullable,
          defaultValue: row.default_value,
          primaryKey: row.primary_key,
          references: row.reference === null ? null : JSON.parse(row.reference),
        })),
      };
    }
  }
}

type Row = ReadonlyArray<string | number | boolean | null>;

function readPage(cursor: Cursor<Row>, count: number) {
  return new Promise<{ readonly page: DatabasePage; readonly result: pg.QueryResult }>(
    (resolve, reject) => {
      cursor.read(count, (error, rows, result) => {
        if (error) return reject(error);
        resolve({
          page: { rows: rows.map((row) => row.map(toCell)), done: rows.length < count },
          result,
        });
      });
    },
  );
}

/** One console connection; a cursor borrows it until that result closes. */
export async function openPostgresSession(
  target: DatabasePostgresTarget,
  password: string | null,
  readOnly: boolean,
): Promise<DatabaseSession> {
  const login = await resolvePostgresLogin(target, password).catch((cause) => {
    throw engineError(cause);
  });
  const client = await connectWithSslMode(target, login).catch((cause) => {
    throw engineError(cause);
  });
  let cancelled = false;
  let typeNames: Map<number, string> | undefined;

  const loadTypeNames = async () => {
    typeNames ??= new Map(
      (
        await client.query<{ oid: number; name: string }>(
          "SELECT oid, typname AS name FROM pg_type",
        )
      ).rows.map((row) => [row.oid, row.name]),
    );
    return typeNames;
  };

  try {
    // A guard against accidents, not a security boundary: the same session could switch it back.
    if (readOnly) await client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
  } catch (cause) {
    await client.end().catch(() => {});
    throw engineError(cause);
  }

  return {
    cancelClosesSession: false,
    serverVersion: async () => {
      try {
        const result = await client.query<{ server_version: string }>("SHOW server_version");
        return result.rows[0]?.server_version ?? "unknown";
      } catch (cause) {
        throw engineError(cause);
      }
    },
    introspect: async (scope) => {
      try {
        return await introspect(client, scope);
      } catch (cause) {
        throw engineError(cause);
      }
    },
    execute: async (sql, pageSize) => {
      cancelled = false;
      try {
        // Type names come first: the connection is busy for as long as the cursor stays open.
        const names = await loadTypeNames();
        const cursor = client.query(new Cursor<Row>(sql, undefined, { rowMode: "array", types }));
        const { page, result } = await readPage(cursor, pageSize);
        if (result.fields.length === 0) {
          await cursor.close();
          return {
            kind: "command",
            command: result.command ?? "OK",
            affectedRows: typeof result.rowCount === "number" ? result.rowCount : null,
          };
        }
        return {
          kind: "rows",
          firstPage: page,
          cursor: {
            columns: result.fields.map((field) => ({
              name: field.name,
              dataType: names.get(field.dataTypeID) ?? String(field.dataTypeID),
            })),
            read: async (count) => {
              try {
                return (await readPage(cursor, count)).page;
              } catch (cause) {
                throw engineError(cause, cancelled);
              }
            },
            close: () => cursor.close(),
          },
        };
      } catch (cause) {
        throw engineError(cause, cancelled);
      }
    },
    cancel: async () => {
      cancelled = true;
      const pid = (client as { readonly processID?: unknown }).processID;
      if (typeof pid !== "number") return;
      // The cancel must reach the session's server as its role, even if a rotated secret now
      // names another; only a fresh password for that same login is taken, since IAM tokens expire.
      const fresh = await resolvePostgresLogin(target, password).catch(() => login);
      const sameLogin =
        fresh.host === login.host && fresh.port === login.port && fresh.user === login.user;
      const canceller = await connectWithSslMode(target, sameLogin ? fresh : login);
      try {
        await canceller.query("SELECT pg_cancel_backend($1)", [pid]);
      } finally {
        await canceller.end().catch(() => {});
      }
    },
    close: () => client.end().catch(() => {}),
  };
}
