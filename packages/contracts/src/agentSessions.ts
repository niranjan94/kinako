import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const AgentSessionSource = Schema.Literals(["claudeAgent", "codex"]);
export type AgentSessionSource = typeof AgentSessionSource.Type;

export const AgentSessionImportSource = Schema.Struct({
  provider: AgentSessionSource,
  providerInstanceId: ProviderInstanceId,
  providerSessionId: TrimmedNonEmptyString,
  filePath: TrimmedNonEmptyString,
  size: NonNegativeInt,
  mtimeMs: Schema.NullOr(Schema.Number),
  device: Schema.Number,
  // A decimal string keeps file IDs above 2^53 (common on NTFS) exact. Older
  // records stored a number.
  inode: Schema.NullOr(Schema.Union([Schema.String, Schema.Number])),
  birthtimeMs: Schema.NullOr(Schema.Number),
});
export type AgentSessionImportSource = typeof AgentSessionImportSource.Type;

/** How far back to look, in milliseconds before the server's clock. Absent means all time. */
const AgentSessionMaxAge = Schema.optional(NonNegativeInt);

export const AgentSessionScanInput = Schema.Struct({
  maxAgeMs: AgentSessionMaxAge,
});
export type AgentSessionScanInput = typeof AgentSessionScanInput.Type;

export const AgentSessionProjectGit = Schema.Struct({
  remoteKey: Schema.NullOr(Schema.String),
  repository: Schema.NullOr(Schema.String),
});
export type AgentSessionProjectGit = typeof AgentSessionProjectGit.Type;

export const AgentSessionProjectCandidate = Schema.Struct({
  path: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  projectId: Schema.optional(ProjectId),
  sources: Schema.Array(AgentSessionSource),
  threadCount: NonNegativeInt,
  lastActiveAt: Schema.NullOr(IsoDateTime),
  alreadyImported: Schema.Boolean,
  git: Schema.optionalKey(Schema.NullOr(AgentSessionProjectGit)),
});
export type AgentSessionProjectCandidate = typeof AgentSessionProjectCandidate.Type;

export const AgentSessionScanResult = Schema.Struct({
  candidates: Schema.Array(AgentSessionProjectCandidate),
  scannedAt: IsoDateTime,
  truncated: Schema.optional(Schema.Boolean),
});
export type AgentSessionScanResult = typeof AgentSessionScanResult.Type;

export const AgentSessionImportInput = Schema.Struct({
  projectId: ProjectId,
  expectedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
});
export type AgentSessionImportInput = typeof AgentSessionImportInput.Type;

export class AgentSessionImportProjectNotFoundError extends Schema.TaggedError<AgentSessionImportProjectNotFoundError>()(
  "AgentSessionImportProjectNotFoundError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project '${this.projectId}' does not exist.`;
  }
}

export class AgentSessionImportProjectChangedError extends Schema.TaggedError<AgentSessionImportProjectChangedError>()(
  "AgentSessionImportProjectChangedError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project '${this.projectId}' changed directories. Scan for projects again before importing history.`;
  }
}

export const AgentSessionImportResult = Schema.Struct({
  importedCount: NonNegativeInt,
  skippedCount: NonNegativeInt,
});
export type AgentSessionImportResult = typeof AgentSessionImportResult.Type;

/** Where a listing continues, from a previous result's `nextCursor`. */
const AgentSessionListCursor = Schema.optional(NonNegativeInt);

/**
 * A project's sessions, or a scanned folder's whether or not it is a project yet. Listing by
 * folder reuses the discovery of the latest scan, since the folder came from one, and reports a
 * session's live thread in any project.
 */
export const AgentSessionListInput = Schema.Union([
  Schema.Struct({
    projectId: ProjectId,
    maxAgeMs: AgentSessionMaxAge,
    cursor: AgentSessionListCursor,
  }),
  Schema.Struct({
    workspaceRoot: TrimmedNonEmptyString,
    maxAgeMs: AgentSessionMaxAge,
    cursor: AgentSessionListCursor,
  }),
]);
export type AgentSessionListInput = typeof AgentSessionListInput.Type;

/**
 * A session started in a terminal from the project's directory. `importedThreadId` is the live
 * thread an earlier import made of it, if any.
 */
export const AgentSessionListItem = Schema.Struct({
  provider: AgentSessionSource,
  providerInstanceId: ProviderInstanceId,
  providerSessionId: TrimmedNonEmptyString,
  title: Schema.String,
  updatedAt: IsoDateTime,
  importedThreadId: Schema.NullOr(ThreadId),
});
export type AgentSessionListItem = typeof AgentSessionListItem.Type;

/** `nextCursor` lists the older sessions past this page's limit. */
export const AgentSessionListResult = Schema.Struct({
  sessions: Schema.Array(AgentSessionListItem),
  nextCursor: Schema.optional(NonNegativeInt),
});
export type AgentSessionListResult = typeof AgentSessionListResult.Type;

export const AgentSessionImportSessionInput = Schema.Struct({
  projectId: ProjectId,
  providerInstanceId: ProviderInstanceId,
  providerSessionId: TrimmedNonEmptyString,
});
export type AgentSessionImportSessionInput = typeof AgentSessionImportSessionInput.Type;

/** `imported` is false when the session already had a live thread, which is returned instead. */
export const AgentSessionImportSessionResult = Schema.Struct({
  threadId: ThreadId,
  imported: Schema.Boolean,
});
export type AgentSessionImportSessionResult = typeof AgentSessionImportSessionResult.Type;

export class AgentSessionNotFoundError extends Schema.TaggedError<AgentSessionNotFoundError>()(
  "AgentSessionNotFoundError",
  { providerInstanceId: ProviderInstanceId, providerSessionId: TrimmedNonEmptyString },
) {
  override get message(): string {
    return `Session '${this.providerSessionId}' is not available to import into this project.`;
  }
}

export class AgentSessionImportFailedError extends Schema.TaggedError<AgentSessionImportFailedError>()(
  "AgentSessionImportFailedError",
  { providerSessionId: TrimmedNonEmptyString, cause: Schema.Defect() },
) {
  override get message(): string {
    const reason =
      this.cause instanceof Error && this.cause.message.length > 0 ? ` ${this.cause.message}` : "";
    return `Could not import session '${this.providerSessionId}'.${reason}`;
  }
}

export class AgentSessionScanError extends Schema.TaggedError<AgentSessionScanError>()(
  "AgentSessionScanError",
  {
    operation: Schema.Literals(["read-settings", "read-projects"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to scan agent sessions during ${this.operation}.`;
  }
}
