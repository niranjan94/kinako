import type { IssueListEntry } from "@t3tools/contracts";
import { pullRequestTarget, type PullRequestReferenceParams } from "./usePullRequestDiff";

export type IssueParams = PullRequestReferenceParams & {
  readonly initialSummary?: IssueListEntry;
};

export const issueTarget = (params: IssueParams) => pullRequestTarget(params);
