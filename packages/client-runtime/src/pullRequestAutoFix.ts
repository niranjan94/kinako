import {
  PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS,
  type ThreadPullRequestWatch,
} from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

export interface PullRequestAutoFixStatus {
  readonly paused: boolean;
  readonly label: string;
  readonly description: string;
}

/** What a watched pull request's auto-fix is doing, or null when it is off. */
export function pullRequestAutoFixStatus(
  watch: ThreadPullRequestWatch | undefined,
  resolve: MFunctionType = mFallback,
): PullRequestAutoFixStatus | null {
  const autoFix = watch?.autoFix;
  if (autoFix === undefined) return null;
  switch (autoFix.pausedReason) {
    case "attempt-limit":
      return {
        paused: true,
        label: resolve(msg("Auto-fix paused")),
        description: resolve(
          msg("Checks still failed after {max} fix attempts. Turn Auto-fix CI on again to retry.", {
            max: PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS,
          }),
        ),
      };
    case "no-push":
      return {
        paused: true,
        label: resolve(msg("Auto-fix paused")),
        description: resolve(
          msg(
            "The last fix turn ended without pushing a commit. Turn Auto-fix CI on again to retry.",
          ),
        ),
      };
    case null:
      return {
        paused: false,
        label: resolve(msg("Auto-fixing CI")),
        description:
          autoFix.attempts === 0
            ? resolve(
                msg(
                  "The agent gets a fix turn when checks fail, up to {max} times until they pass.",
                  { max: PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS },
                ),
              )
            : resolve(
                msg("Fix attempt {attempt} of {max} since checks last passed.", {
                  attempt: autoFix.attempts,
                  max: PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS,
                }),
              ),
      };
  }
}

/** The toggle for a pull request's auto-fix: its label and the `autoFix` it sends. */
export function pullRequestAutoFixToggle(
  watch: ThreadPullRequestWatch | undefined,
  resolve: MFunctionType = mFallback,
): {
  readonly label: string;
  readonly autoFix: boolean;
} {
  const status = pullRequestAutoFixStatus(watch, resolve);
  if (status === null) return { label: resolve(msg("Auto-fix CI")), autoFix: true };
  return status.paused
    ? { label: resolve(msg("Resume auto-fix CI")), autoFix: true }
    : { label: resolve(msg("Stop auto-fixing CI")), autoFix: false };
}
