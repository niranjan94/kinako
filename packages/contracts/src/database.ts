import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  PortSchema,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/** Rows a single page may carry. The grid asks for more as the user scrolls. */
const DATABASE_PAGE_SIZE_MAX = 500;
export const DATABASE_PAGE_SIZE_DEFAULT = 200;
/** Characters a text cell keeps on the wire; shortened values also carry their full length. */
export const DATABASE_CELL_TEXT_MAX = 2_000;
const DATABASE_SQL_MAX_LENGTH = 1_000_000;
const DATABASE_NAME_MAX_LENGTH = 128;

export const DatabaseConnectionId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-zA-Z0-9_-]+$/),
).pipe(Schema.brand("DatabaseConnectionId"));
export type DatabaseConnectionId = typeof DatabaseConnectionId.Type;

/** Chosen by the client so a query can be cancelled before its first page returns. */
export const DatabaseQueryId = TrimmedNonEmptyString.check(Schema.isMaxLength(64)).pipe(
  Schema.brand("DatabaseQueryId"),
);
export type DatabaseQueryId = typeof DatabaseQueryId.Type;

const Identifier = TrimmedNonEmptyString.check(Schema.isMaxLength(DATABASE_NAME_MAX_LENGTH));

const DatabasePostgresSslMode = Schema.Literals(["disable", "prefer", "require", "verify-full"]);
export type DatabasePostgresSslMode = typeof DatabasePostgresSslMode.Type;

/** Absent profile and region fall back to the environment's default AWS configuration. */
const AwsLocation = {
  profile: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  region: Schema.optionalKey(
    TrimmedNonEmptyString.check(Schema.isMaxLength(64), Schema.isPattern(/^[a-z0-9-]+$/)),
  ),
};

/**
 * How the server obtains the login. AWS credentials resolve on the environment's machine, so a
 * profile names an entry in that machine's AWS configuration, not the client's.
 */
export const DatabasePostgresAuth = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("password") }),
  Schema.Struct({ kind: Schema.Literal("aws-iam"), ...AwsLocation }),
  Schema.Struct({
    kind: Schema.Literal("aws-secrets-manager"),
    ...AwsLocation,
    secretId: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
    /** Connect to the host and port stored in the secret instead of the target's. */
    useSecretHost: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("aws-parameter-store"),
    ...AwsLocation,
    parameterName: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
  }),
]);
export type DatabasePostgresAuth = typeof DatabasePostgresAuth.Type;
export type DatabasePostgresAuthKind = DatabasePostgresAuth["kind"];

export const DatabasePostgresTarget = Schema.Struct({
  engine: Schema.Literal("postgres"),
  host: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  port: PortSchema,
  /** Initial database used for server discovery. */
  database: Identifier,
  /** All discovers connectable databases; a list selects names. Absent shows only the initial database. */
  databaseSelection: Schema.optionalKey(
    Schema.Union([
      Schema.Literal("all"),
      Schema.Array(Identifier).check(Schema.isMinLength(1), Schema.isMaxLength(500)),
    ]),
  ),
  user: Identifier,
  sslMode: DatabasePostgresSslMode,
  /** Absent means a password, which is how connections saved before this field authenticate. */
  auth: Schema.optionalKey(DatabasePostgresAuth),
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
export const DatabaseConnectionLevel = Schema.Literals(["global", "environment", "project"]);
export type DatabaseConnectionLevel = typeof DatabaseConnectionLevel.Type;

export const DatabaseProjectContext = Schema.Struct({ projectId: Schema.optionalKey(ProjectId) });
export type DatabaseProjectContext = typeof DatabaseProjectContext.Type;

export const DatabaseSessionId = TrimmedNonEmptyString.check(Schema.isMaxLength(64)).pipe(
  Schema.brand("DatabaseSessionId"),
);
export type DatabaseSessionId = typeof DatabaseSessionId.Type;

export const DatabaseConnection = Schema.Struct({
  id: DatabaseConnectionId,
  name: Identifier,
  target: DatabaseTarget,
  readOnly: Schema.Boolean,
  hasPassword: Schema.Boolean,
  level: DatabaseConnectionLevel,
  projectId: Schema.NullOr(ProjectId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type DatabaseConnection = typeof DatabaseConnection.Type;

export const DatabaseListConnectionsResult = Schema.Struct({
  connections: Schema.Array(DatabaseConnection),
});
export type DatabaseListConnectionsResult = typeof DatabaseListConnectionsResult.Type;

export const DatabaseConnectionDraft = Schema.Struct({
  level: DatabaseConnectionLevel,
  updatedAt: Schema.optionalKey(IsoDateTime),
  projectId: Schema.optionalKey(ProjectId),
  /** Global copies share a stable id across environments. */
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

export const DatabaseIntrospectScope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("databases") }),
  Schema.Struct({ kind: Schema.Literal("schemas") }),
  Schema.Struct({ kind: Schema.Literal("objects"), schema: Identifier }),
  Schema.Struct({ kind: Schema.Literal("columns"), schema: Identifier, object: Identifier }),
]);
export type DatabaseIntrospectScope = typeof DatabaseIntrospectScope.Type;

export const DatabaseIntrospectInput = Schema.Struct({
  ...DatabaseProjectContext.fields,
  connectionId: DatabaseConnectionId,
  database: Schema.optionalKey(Identifier),
  sessionId: Schema.optionalKey(DatabaseSessionId),
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
    kind: Schema.Literal("databases"),
    databases: Schema.Array(Schema.Struct({ name: Schema.String })),
  }),
  Schema.Struct({
    kind: Schema.Literal("schemas"),
    schemas: Schema.Array(Schema.Struct({ name: Schema.String })),
    searchPath: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    kind: Schema.Literal("objects"),
    objects: Schema.Array(Schema.Struct({ name: Schema.String, type: DatabaseObjectType })),
  }),
  Schema.Struct({ kind: Schema.Literal("columns"), columns: Schema.Array(DatabaseColumnInfo) }),
]);
export type DatabaseIntrospectResult = typeof DatabaseIntrospectResult.Type;

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
  ...DatabaseProjectContext.fields,
  connectionId: DatabaseConnectionId,
  database: Schema.optionalKey(Identifier),
  queryId: DatabaseQueryId,
  sessionId: Schema.optionalKey(DatabaseSessionId),
  forceReadOnly: Schema.optionalKey(Schema.Boolean),
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
  ...DatabaseProjectContext.fields,
  queryId: DatabaseQueryId,
  pageSize: Schema.optionalKey(PageSize),
});
export type DatabaseFetchPageInput = typeof DatabaseFetchPageInput.Type;

export const DatabaseFetchPageResult = Schema.Struct({
  rows: Schema.Array(Schema.Array(DatabaseCell)),
  hasMore: Schema.Boolean,
});
export type DatabaseFetchPageResult = typeof DatabaseFetchPageResult.Type;

export const DatabaseQueryInput = Schema.Struct({
  ...DatabaseProjectContext.fields,
  queryId: DatabaseQueryId,
});
export type DatabaseQueryInput = typeof DatabaseQueryInput.Type;

const DatabaseRequestFailure = Schema.Literals([
  "database-not-selected",
  "connection-not-found",
  "invalid-connection-level",
  "project-mismatch",
  "session-not-found",
  "session-busy",
  "session-id-in-use",
  "too-many-open-sessions",
  "query-not-found",
  "query-id-in-use",
  "too-many-open-queries",
  "storage-failed",
  "engine-failed",
]);
export type DatabaseRequestFailure = typeof DatabaseRequestFailure.Type;

const databaseRequestMessages: Record<DatabaseRequestFailure, string> = {
  "database-not-selected":
    "Choose a database included in this connection. Open a new tab to change an editor’s database.",
  "invalid-connection-level":
    "Choose a project for project connections. SQLite connections cannot be global.",
  "project-mismatch": "That connection or result belongs to another project.",
  "session-not-found": "That editor session has closed. Open a new query tab.",
  "session-busy": "Finish or close the current result before running another statement.",
  "session-id-in-use": "That editor session is already open.",
  "too-many-open-sessions": "Too many database editors are open. Close some tabs and try again.",
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

export const DatabaseOpenSessionInput = Schema.Struct({
  ...DatabaseProjectContext.fields,
  connectionId: DatabaseConnectionId,
  database: Schema.optionalKey(Identifier),
  sessionId: DatabaseSessionId,
  forceReadOnly: Schema.optionalKey(Schema.Boolean),
});
export type DatabaseOpenSessionInput = typeof DatabaseOpenSessionInput.Type;
export const DatabaseSessionInput = Schema.Struct({
  ...DatabaseProjectContext.fields,
  sessionId: DatabaseSessionId,
});
export type DatabaseSessionInput = typeof DatabaseSessionInput.Type;

export const DatabaseBrowseTableInput = Schema.Struct({
  ...DatabaseProjectContext.fields,
  connectionId: DatabaseConnectionId,
  database: Schema.optionalKey(Identifier),
  schema: Identifier,
  object: Identifier,
  where: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(10000))),
  orderBy: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
  offset: Schema.optionalKey(NonNegativeInt),
  after: Schema.optionalKey(
    Schema.Array(Schema.Union([Schema.Null, Schema.String, Schema.Number, Schema.Boolean])),
  ),
  pageSize: Schema.optionalKey(PageSize),
});
export type DatabaseBrowseTableInput = typeof DatabaseBrowseTableInput.Type;
export const DatabaseBrowseTableResult = Schema.Struct({
  columns: Schema.Array(DatabaseResultColumn),
  rows: Schema.Array(Schema.Array(DatabaseCell)),
  hasMore: Schema.Boolean,
  nextOffset: NonNegativeInt,
  nextAfter: Schema.NullOr(
    Schema.Array(Schema.Union([Schema.Null, Schema.String, Schema.Number, Schema.Boolean])),
  ),
});
export type DatabaseBrowseTableResult = typeof DatabaseBrowseTableResult.Type;
