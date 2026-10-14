import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  PullRequestActor,
  PullRequestComment,
  PullRequestCommentInput,
  PullRequestLabel,
  PullRequestListCursors,
  PullRequestListProjectError,
  PullRequestRef,
} from "./pullRequest.ts";
import { SourceControlProviderKind } from "./sourceControl.ts";

/**
 * Issues share the pull request browser, its project and host resolution, and its routing across
 * environments. A host numbers issues and change requests from one sequence per repository, so an
 * issue is addressed by the same reference a pull request is.
 */
export const IssueState = Schema.Literals(["open", "closed"]);
export type IssueState = typeof IssueState.Type;

export const IssueListState = Schema.Literals(["all", "open", "closed"]);
export type IssueListState = typeof IssueListState.Type;

export const IssueListInput = Schema.Struct({
  state: IssueListState,
  projectId: Schema.optional(ProjectId),
  projectIds: Schema.optional(Schema.Array(ProjectId).check(Schema.isMaxLength(100))),
  host: Schema.optional(TrimmedNonEmptyString),
  /** Rows to return per slice. */
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
  cursors: Schema.optional(PullRequestListCursors),
  query: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
});
export type IssueListInput = typeof IssueListInput.Type;

const IssueFields = {
  provider: SourceControlProviderKind,
  host: TrimmedNonEmptyString,
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  author: Schema.NullOr(PullRequestActor),
  state: IssueState,
  labels: Schema.Array(PullRequestLabel),
  assignees: Schema.Array(PullRequestActor),
  commentCount: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  closedAt: Schema.NullOr(IsoDateTime),
};

export const IssueListEntry = Schema.Struct({
  ...IssueFields,
  /** Server epoch milliseconds when the provider read started; preserved on cache hits. */
  observedAt: Schema.optional(Schema.Finite),
});
export type IssueListEntry = typeof IssueListEntry.Type;

export const IssueListResult = Schema.Struct({
  /** By update, newest first, across every repository this answer covers. */
  entries: Schema.Array(IssueListEntry),
  errors: Schema.Array(PullRequestListProjectError),
  truncated: Schema.Boolean,
  /** Where each repository carries on, sent straight back as `cursors`. */
  nextCursors: PullRequestListCursors,
});
export type IssueListResult = typeof IssueListResult.Type;

export const IssueRef = PullRequestRef;
export type IssueRef = PullRequestRef;

export const IssueDetail = Schema.Struct({
  ...IssueFields,
  workspaceRoot: TrimmedNonEmptyString,
  body: Schema.String,
  /** Oldest first. */
  comments: Schema.Array(PullRequestComment),
  /** The conversation is longer than what was read. */
  commentsTruncated: Schema.Boolean,
  /** The host takes comments on issues and this viewer may post one. */
  canComment: Schema.Boolean,
  observedAt: Schema.optional(Schema.Finite),
});
export type IssueDetail = typeof IssueDetail.Type;

export const IssueCommentInput = PullRequestCommentInput;
export type IssueCommentInput = PullRequestCommentInput;
