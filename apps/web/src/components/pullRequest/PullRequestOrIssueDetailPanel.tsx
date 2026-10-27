import type { IssueRef } from "@t3tools/contracts";
import type { ComponentProps } from "react";

import { IssueDetailPanel } from "./IssueDetailPanel";
import { PullRequestDetailPanel } from "./PullRequestDetailPanel";

/** The page's detail panel, showing an issue in place of a pull request when one is selected. */
export function PullRequestOrIssueDetailPanel({
  issue,
  ...props
}: ComponentProps<typeof PullRequestDetailPanel> & { readonly issue: IssueRef | null }) {
  return issue ? (
    <IssueDetailPanel
      environmentId={props.environmentId}
      reference={issue}
      {...(props.refreshToken === undefined ? {} : { refreshToken: props.refreshToken })}
    />
  ) : (
    <PullRequestDetailPanel {...props} />
  );
}
