import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { WorktreeMcpSetupScriptStatus } from "./worktreeMcp.ts";

export const VcsMoveThreadInput = Schema.Struct({
  threadId: ThreadId,
  expectedWorktreePath: Schema.NullOr(TrimmedNonEmptyString),
  target: Schema.Union([
    Schema.Literal("local"),
    Schema.Struct({
      worktree: Schema.Union([
        Schema.Literal("associated"),
        Schema.Struct({
          branch: TrimmedNonEmptyString,
          baseRef: Schema.optional(TrimmedNonEmptyString),
        }),
      ]),
    }),
  ]),
  runSetupScript: Schema.optional(Schema.Boolean),
});
export type VcsMoveThreadInput = typeof VcsMoveThreadInput.Type;

export const VcsMoveThreadResult = Schema.Struct({
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  conflicts: Schema.Boolean,
  cleanupPending: Schema.Boolean,
  setupScript: WorktreeMcpSetupScriptStatus,
});
export type VcsMoveThreadResult = typeof VcsMoveThreadResult.Type;

export class ThreadWorkspaceError extends Schema.TaggedError<ThreadWorkspaceError>()(
  "ThreadWorkspaceError",
  {
    reason: Schema.Literals([
      "thread_unavailable",
      "active_run",
      "workspace_changed",
      "target_dirty",
      "target_missing",
      "different_base",
      "conflict",
      "in_progress",
      "git_failed",
      "submodule_changes",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "thread_unavailable":
        return "The thread must exist and be unarchived to move its workspace.";
      case "active_run":
        return "Wait for the thread's active run to finish before moving its workspace.";
      case "workspace_changed":
        return "The thread's workspace changed. Refresh before trying again.";
      case "target_dirty":
        return "The destination has uncommitted changes. Commit or stash them before moving.";
      case "target_missing":
        return "No associated worktree was found. Choose a new branch instead.";
      case "different_base":
        return "The destination worktree must be at the same commit as the source.";
      case "conflict":
        return "The changes could not be applied safely. The source changes are preserved.";
      case "in_progress":
        return "Another workspace move is in progress for this project.";
      case "git_failed":
        return "Git could not move the workspace. The source changes are preserved.";
      case "submodule_changes":
        return "Commit or stash submodule changes, including updated submodule commits in the parent repository, before moving the workspace.";
    }
  }
}
