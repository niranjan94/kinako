import type { OrchestrationV2TurnItem, ThreadId } from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

export type FollowUpItem = Extract<OrchestrationV2TurnItem, { readonly type: "follow_up" }>;

export type FollowUpDisplay =
  | { readonly kind: "suggested" }
  | { readonly kind: "dismissed" }
  | { readonly kind: "started"; readonly threadId: ThreadId | null }
  | { readonly kind: "elsewhere" };

/**
 * `visibility` is the projected row's: a follow-up inherited from another
 * thread (a fork) can only be acted on where it was suggested.
 */
export function followUpDisplay(
  item: Pick<FollowUpItem, "followUpStatus" | "startedThreadId">,
  visibility: "local" | "inherited" | "synthetic",
): FollowUpDisplay {
  if (item.followUpStatus === "started") {
    return { kind: "started", threadId: item.startedThreadId ?? null };
  }
  if (visibility !== "local") return { kind: "elsewhere" };
  return item.followUpStatus === "dismissed" ? { kind: "dismissed" } : { kind: "suggested" };
}

const USER_FACING_FAILURE_TAGS = new Set(["FollowUpError", "EnvironmentAuthorizationError"]);

export function followUpFailureMessage(
  failure: unknown,
  resolve: MFunctionType = mFallback,
): string {
  if (
    typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    typeof failure._tag === "string" &&
    USER_FACING_FAILURE_TAGS.has(failure._tag) &&
    "message" in failure &&
    typeof failure.message === "string" &&
    failure.message.trim().length > 0
  ) {
    return failure.message;
  }
  return resolve(msg("Could not update the follow-up. Try again."));
}
