import {
  DATABASE_CELL_TEXT_MAX,
  type DatabaseCell,
  type DatabaseIntrospectResult,
  type DatabaseIntrospectScope,
  type DatabaseResultColumn,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * A statement the engine rejected or that could not reach the engine. `engineMessage` is the
 * engine's text and is shown to the user; it is not a diagnostic.
 */
export class DatabaseEngineError extends Schema.TaggedError<DatabaseEngineError>()(
  "DatabaseEngineError",
  {
    engineMessage: Schema.String,
    code: Schema.NullOr(Schema.String),
    position: Schema.NullOr(Schema.Number),
    cancelled: Schema.Boolean,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "The database rejected the request.";
  }
}

export const isDatabaseEngineError = Schema.is(DatabaseEngineError);

/** An open result set. Rows stay on the server until the grid asks for them. */
export interface DatabaseCursor {
  readonly columns: ReadonlyArray<DatabaseResultColumn>;
  /** Up to `count` rows; `done` once the engine has no more. */
  readonly read: (count: number) => Promise<DatabasePage>;
  readonly close: () => Promise<void>;
}

export interface DatabasePage {
  readonly rows: ReadonlyArray<ReadonlyArray<DatabaseCell>>;
  readonly done: boolean;
}

export type DatabaseStatementOutcome =
  | { readonly kind: "rows"; readonly firstPage: DatabasePage; readonly cursor: DatabaseCursor }
  | { readonly kind: "command"; readonly command: string; readonly affectedRows: number | null };

/**
 * One engine adapter. Implementations wrap a driver library and translate its errors into
 * `DatabaseEngineError`; everything above this boundary is engine-neutral.
 */
export interface DatabaseSession {
  readonly serverVersion: () => Promise<string>;
  readonly introspect: (scope: DatabaseIntrospectScope) => Promise<DatabaseIntrospectResult>;
  /**
   * Runs one statement and reads its first page, which is how a row set is told apart from a
   * command. The session belongs to the returned cursor until it closes.
   */
  readonly execute: (sql: string, pageSize: number) => Promise<DatabaseStatementOutcome>;
  /** Best effort: asks the engine to stop the running statement. */
  readonly cancel: () => Promise<void>;
  readonly close: () => Promise<void>;
}

/** Cuts long text so one wide cell cannot bloat a page on the wire. */
export function toCell(value: string | number | boolean | null): DatabaseCell {
  if (typeof value !== "string" || value.length <= DATABASE_CELL_TEXT_MAX) return value;
  return { truncated: value.slice(0, DATABASE_CELL_TEXT_MAX), length: value.length };
}

/** A rough wire size, used to stop a page early when its cells are large. */
export function cellWeight(cell: DatabaseCell): number {
  if (cell === null || typeof cell === "boolean") return 4;
  if (typeof cell === "number") return 12;
  if (typeof cell === "string") return cell.length + 2;
  return cell.truncated.length + 24;
}
