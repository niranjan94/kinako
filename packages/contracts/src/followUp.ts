import * as Schema from "effect/Schema";

import { ThreadId, TurnItemId } from "./baseSchemas.ts";

export const FollowUpStartInput = Schema.Struct({
  threadId: ThreadId,
  turnItemId: TurnItemId,
  /**
   * `current` reuses the suggesting thread's checkout; `worktree` branches a new one from it.
   * Omitted follows the project's default for new threads.
   */
  workspace: Schema.optional(Schema.Literals(["current", "worktree"])),
});
export type FollowUpStartInput = typeof FollowUpStartInput.Type;

export const FollowUpStartResult = Schema.Struct({
  threadId: ThreadId,
});
export type FollowUpStartResult = typeof FollowUpStartResult.Type;

export const FollowUpSetDismissedInput = Schema.Struct({
  threadId: ThreadId,
  turnItemId: TurnItemId,
  dismissed: Schema.Boolean,
});
export type FollowUpSetDismissedInput = typeof FollowUpSetDismissedInput.Type;

const FOLLOW_UP_FAILURE_MESSAGES = {
  load_failed: "Could not load the follow-up.",
  not_found: "This follow-up no longer exists.",
  already_started: "A thread was already started for this follow-up.",
  no_base_branch: "This thread has no branch to start a worktree from.",
  launch_failed: "Could not start the follow-up thread.",
  record_failed: "Could not update the follow-up.",
} as const;

export const FollowUpFailureReason = Schema.Literals(
  Object.keys(FOLLOW_UP_FAILURE_MESSAGES) as Array<keyof typeof FOLLOW_UP_FAILURE_MESSAGES>,
);
export type FollowUpFailureReason = typeof FollowUpFailureReason.Type;

export class FollowUpError extends Schema.TaggedError<FollowUpError>()("FollowUpError", {
  reason: FollowUpFailureReason,
  detail: Schema.optionalKey(Schema.String),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail ?? FOLLOW_UP_FAILURE_MESSAGES[this.reason];
  }
}
