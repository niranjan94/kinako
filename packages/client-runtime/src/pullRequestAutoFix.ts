import {
  PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS,
  type ThreadPullRequestWatch,
} from "@t3tools/contracts";

export interface PullRequestAutoFixStatus {
  readonly paused: boolean;
  readonly label: string;
  readonly description: string;
}

/** What a watched pull request's auto-fix is doing, or null when it is off. */
export function pullRequestAutoFixStatus(
  watch: ThreadPullRequestWatch | undefined,
): PullRequestAutoFixStatus | null {
  const autoFix = watch?.autoFix;
  if (autoFix === undefined) return null;
  switch (autoFix.pausedReason) {
    case "attempt-limit":
      return {
        paused: true,
        label: "Auto-fix paused",
        description: `Checks still failed after ${PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS} fix attempts. Turn Auto-fix CI on again to retry.`,
      };
    case "no-push":
      return {
        paused: true,
        label: "Auto-fix paused",
        description:
          "The last fix turn ended without pushing a commit. Turn Auto-fix CI on again to retry.",
      };
    case null:
      return {
        paused: false,
        label: "Auto-fixing CI",
        description:
          autoFix.attempts === 0
            ? `The agent gets a fix turn when checks fail, up to ${PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS} times until they pass.`
            : `Fix attempt ${autoFix.attempts} of ${PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS} since checks last passed.`,
      };
  }
}

/** The toggle for a pull request's auto-fix: its label and the `autoFix` it sends. */
export function pullRequestAutoFixToggle(watch: ThreadPullRequestWatch | undefined): {
  readonly label: string;
  readonly autoFix: boolean;
} {
  const status = pullRequestAutoFixStatus(watch);
  if (status === null) return { label: "Auto-fix CI", autoFix: true };
  return status.paused
    ? { label: "Resume auto-fix CI", autoFix: true }
    : { label: "Stop auto-fixing CI", autoFix: false };
}
