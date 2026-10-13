import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  PortSchema,
  PositiveInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/** Rows a single page may carry. The grid asks for more as the user scrolls. */
const DATABASE_PAGE_SIZE_MAX = 500;
export const DATABASE_PAGE_SIZE_DEFAULT = 200;
/** Characters a text cell keeps on the wire; the rest is fetched only when opened. */
export const DATABASE_CELL_TEXT_MAX = 2_000;
const DATABASE_SQL_MAX_LENGTH = 1_000_000;
const DATABASE_NAME_MAX_LENGTH = 128;

export const DatabaseConnectionId = TrimmedNonEmptyString.pipe(
  Schema.brand("DatabaseConnectionId"),
);
export type DatabaseConnectionId = typeof DatabaseConnectionId.Type;

/** Chosen by the client so a query can be cancelled before its first page returns. */
export const DatabaseQueryId = TrimmedNonEmptyString.check(Schema.isMaxLength(64)).pipe(
  Schema.brand("DatabaseQueryId"),
);
export type DatabaseQueryId = typeof DatabaseQueryId.Type;

const Identifier = TrimmedNonEmptyString.check(Schema.isMaxLength(DATABASE_NAME_MAX_LENGTH));

const DatabasePostgresSslMode = Schema.Literals(["disable", "prefer", "require", "verify-full"]);
export type DatabasePostgresSslMode = typeof DatabasePostgresSslMode.Type;

export const DatabasePostgresTarget = Schema.Struct({
  engine: Schema.Literal("postgres"),
  host: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  port: PortSchema,
  database: Identifier,
  user: Identifier,
  sslMode: DatabasePostgresSslMode,
});
export type DatabasePostgresTarget = typeof DatabasePostgresTarget.Type;

export const DatabaseSqliteTarget = Schema.Struct({
  engine: Schema.Literal("sqlite"),
  /** Absolute path on the environment's machine, not the client's. */
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
});
export type DatabaseSqliteTarget = typeof DatabaseSqliteTarget.Type;

export const DatabaseTarget = Schema.Union([DatabasePostgresTarget, DatabaseSqliteTarget]);
export type DatabaseTarget = typeof DatabaseTarget.Type;
export type DatabaseEngine = DatabaseTarget["engine"];

/** A saved connection. Passwords never leave the server; `hasPassword` says whether one is stored. */
export const DatabaseConnection = Schema.Struct({
  id: DatabaseConnectionId,
  name: Identifier,
  target: DatabaseTarget,
  readOnly: Schema.Boolean,
  hasPassword: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type DatabaseConnection = typeof DatabaseConnection.Type;

export const DatabaseListConnectionsResult = Schema.Struct({
  connections: Schema.Array(DatabaseConnection),
});
export type DatabaseListConnectionsResult = typeof DatabaseListConnectionsResult.Type;

export const DatabaseConnectionDraft = Schema.Struct({
  /** Present when editing; absent creates a connection. */
  id: Schema.optionalKey(DatabaseConnectionId),
  name: Identifier,
  target: DatabaseTarget,
  readOnly: Schema.Boolean,
  /** Omitted keeps the stored password, null removes it. */
  password: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(1024)))),
});
export type DatabaseConnectionDraft = typeof DatabaseConnectionDraft.Type;

export const DatabaseDeleteConnectionInput = Schema.Struct({ id: DatabaseConnectionId });
export type DatabaseDeleteConnectionInput = typeof DatabaseDeleteConnectionInput.Type;

export const DatabaseTestConnectionResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), serverVersion: Schema.String }),
  Schema.Struct({ ok: Schema.Literal(false), message: Schema.String }),
]);
export type DatabaseTestConnectionResult = typeof DatabaseTestConnectionResult.Type;

// ---- Introspection, one level at a time so large databases never load whole.

export const DatabaseIntrospectScope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("schemas") }),
  Schema.Struct({ kind: Schema.Literal("objects"), schema: Identifier }),
  Schema.Struct({ kind: Schema.Literal("columns"), schema: Identifier, object: Identifier }),
]);
export type DatabaseIntrospectScope = typeof DatabaseIntrospectScope.Type;

export const DatabaseIntrospectInput = Schema.Struct({
  connectionId: DatabaseConnectionId,
  scope: DatabaseIntrospectScope,
});
export type DatabaseIntrospectInput = typeof DatabaseIntrospectInput.Type;

const DatabaseObjectType = Schema.Literals(["table", "view", "materialized-view"]);
export type DatabaseObjectType = typeof DatabaseObjectType.Type;

const DatabaseColumnInfo = Schema.Struct({
  name: Schema.String,
  dataType: Schema.String,
  nullable: Schema.Boolean,
  defaultValue: Schema.NullOr(Schema.String),
  primaryKey: Schema.Boolean,
  references: Schema.NullOr(
    Schema.Struct({ schema: Schema.String, object: Schema.String, column: Schema.String }),
  ),
});
export type DatabaseColumnInfo = typeof DatabaseColumnInfo.Type;

export const DatabaseIntrospectResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("schemas"),
    schemas: Schema.Array(Schema.Struct({ name: Schema.String })),
  }),
  Schema.Struct({
    kind: Schema.Literal("objects"),
    objects: Schema.Array(Schema.Struct({ name: Schema.String, type: DatabaseObjectType })),
  }),
  Schema.Struct({ kind: Schema.Literal("columns"), columns: Schema.Array(DatabaseColumnInfo) }),
]);
export type DatabaseIntrospectResult = typeof DatabaseIntrospectResult.Type;

// ---- Queries

/** A cell as the grid shows it. Long text is cut; `length` is the full character count. */
export const DatabaseCell = Schema.Union([
  Schema.Null,
  Schema.Boolean,
  Schema.Number,
  Schema.String,
  Schema.Struct({ truncated: Schema.String, length: NonNegativeInt }),
]);
export type DatabaseCell = typeof DatabaseCell.Type;

export const DatabaseResultColumn = Schema.Struct({ name: Schema.String, dataType: Schema.String });
export type DatabaseResultColumn = typeof DatabaseResultColumn.Type;

const PageSize = PositiveInt.check(Schema.isLessThanOrEqualTo(DATABASE_PAGE_SIZE_MAX));

export const DatabaseExecuteInput = Schema.Struct({
  connectionId: DatabaseConnectionId,
  queryId: DatabaseQueryId,
  sql: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(DATABASE_SQL_MAX_LENGTH)),
  pageSize: Schema.optionalKey(PageSize),
});
export type DatabaseExecuteInput = typeof DatabaseExecuteInput.Type;

/**
 * What running one statement produced. A database error is an outcome the user reads, like a
 * row set, so it is a result rather than an RPC failure.
 */
export const DatabaseExecuteResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("rows"),
    columns: Schema.Array(DatabaseResultColumn),
    rows: Schema.Array(Schema.Array(DatabaseCell)),
    /** False once the result is exhausted; the server has already released the cursor. */
    hasMore: Schema.Boolean,
    durationMs: NonNegativeInt,
  }),
  Schema.Struct({
    kind: Schema.Literal("command"),
    command: Schema.String,
    affectedRows: Schema.NullOr(NonNegativeInt),
    durationMs: NonNegativeInt,
  }),
  Schema.Struct({
    kind: Schema.Literal("failed"),
    message: Schema.String,
    /** Engine error code, such as Postgres SQLSTATE. */
    code: Schema.NullOr(Schema.String),
    /** 1-based character offset into the statement, when the engine reports one. */
    position: Schema.NullOr(PositiveInt),
    cancelled: Schema.Boolean,
    durationMs: NonNegativeInt,
  }),
]);
export type DatabaseExecuteResult = typeof DatabaseExecuteResult.Type;

export const DatabaseFetchPageInput = Schema.Struct({
  queryId: DatabaseQueryId,
  pageSize: Schema.optionalKey(PageSize),
});
export type DatabaseFetchPageInput = typeof DatabaseFetchPageInput.Type;

export const DatabaseFetchPageResult = Schema.Struct({
  rows: Schema.Array(Schema.Array(DatabaseCell)),
  hasMore: Schema.Boolean,
});
export type DatabaseFetchPageResult = typeof DatabaseFetchPageResult.Type;

export const DatabaseQueryInput = Schema.Struct({ queryId: DatabaseQueryId });
export type DatabaseQueryInput = typeof DatabaseQueryInput.Type;

const DatabaseRequestFailure = Schema.Literals([
  "connection-not-found",
  "query-not-found",
  "query-id-in-use",
  "too-many-open-queries",
  "storage-failed",
  "engine-failed",
]);
export type DatabaseRequestFailure = typeof DatabaseRequestFailure.Type;

const databaseRequestMessages: Record<DatabaseRequestFailure, string> = {
  "connection-not-found": "That database connection no longer exists.",
  "query-not-found": "That query result has closed. Run the query again.",
  "query-id-in-use": "A query with that id is already running.",
  "too-many-open-queries": "Too many query results are open. Close some tabs and try again.",
  "storage-failed": "Failed to read or save database connections.",
  "engine-failed": "The database could not complete the request.",
};

export class DatabaseRequestError extends Schema.TaggedError<DatabaseRequestError>()(
  "DatabaseRequestError",
  {
    failure: DatabaseRequestFailure,
    /**
     * The engine's own words for an `engine-failed` request, such as a refused login. The user
     * needs them to fix the connection, so they travel; credentials never appear in them.
     */
    engineMessage: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.engineMessage ?? databaseRequestMessages[this.failure];
  }
}
