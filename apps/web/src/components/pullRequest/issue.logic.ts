import {
  ASK_ABOUT_ISSUE_INSTRUCTIONS,
  issueContextText,
  type HandoffIssue,
} from "@t3tools/client-runtime/issue-handoff";
import type {
  EnvironmentId,
  IssueListEntry,
  IssueRef,
  ProjectId,
  IssueListResult,
  IssueListState,
  PullRequestListCursors,
  PullRequestListState,
} from "@t3tools/contracts";

import type { ReviewCommentContext } from "../../reviewCommentContext";
import type {
  EnvironmentPullRequestError,
  PullRequestAuthorFacet,
  PullRequestLabelFacet,
} from "./pullRequestList.logic";

export interface EnvironmentIssueEntry extends IssueListEntry {
  readonly environmentId: EnvironmentId;
}

export interface MergedIssueList {
  /** Newest update first, across every environment that answered. */
  readonly entries: ReadonlyArray<EnvironmentIssueEntry>;
  readonly errors: ReadonlyArray<EnvironmentPullRequestError>;
  readonly truncated: boolean;
  /** Keyed by environment; an environment absent here has nothing more to give. */
  readonly nextCursors: Readonly<Record<string, PullRequestListCursors>>;
}

export interface IssueListFilters {
  readonly author?: string | undefined;
  readonly labels?: ReadonlyArray<string> | undefined;
}

/**
 * The one shape an issue is asked for in. Query atoms are keyed by their input's JSON, so the
 * panel, its tab and its link must build it alike to share a read.
 */
export function issueReference(target: {
  readonly projectId: string;
  readonly host?: string | undefined;
  readonly repository: string;
  readonly number: number;
}): IssueRef {
  return {
    projectId: target.projectId as ProjectId,
    ...(target.host === undefined ? {} : { host: target.host }),
    repository: target.repository,
    number: target.number,
  };
}

export function issueEntryKey(
  entry: Pick<EnvironmentIssueEntry, "environmentId" | "host" | "repository" | "number">,
): string {
  return `${entry.environmentId}:${entry.host}:${entry.repository.toLowerCase()}#${entry.number}`;
}

/** The page's state filter is shared with pull requests, where a merged one is a closed one. */
export function issueListStateOf(state: PullRequestListState): IssueListState {
  return state === "merged" ? "closed" : state;
}

export function mergeIssueLists(
  answers: ReadonlyArray<readonly [EnvironmentId, IssueListResult]>,
): MergedIssueList | null {
  if (answers.length === 0) return null;
  const entries: EnvironmentIssueEntry[] = [];
  const errors: EnvironmentPullRequestError[] = [];
  const nextCursors: Record<string, PullRequestListCursors> = {};
  let truncated = false;
  for (const [environmentId, answer] of answers) {
    entries.push(...answer.entries.map((entry) => ({ ...entry, environmentId })));
    errors.push(...answer.errors.map((error) => ({ ...error, environmentId })));
    truncated ||= answer.truncated;
    if (Object.keys(answer.nextCursors).length > 0) nextCursors[environmentId] = answer.nextCursors;
  }
  return {
    entries: entries.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    errors,
    truncated,
    nextCursors,
  };
}

/**
 * A continuation is a slice after the rows already held, so those keep their places and the
 * slice lands under them. One repository's next rows can be newer than another's last, so the
 * slice is ordered among itself only.
 */
export function appendIssuePage(
  held: ReadonlyArray<EnvironmentIssueEntry>,
  page: ReadonlyArray<EnvironmentIssueEntry>,
): ReadonlyArray<EnvironmentIssueEntry> {
  const keys = new Set(held.map(issueEntryKey));
  const arrived = page
    .filter((entry) => !keys.has(issueEntryKey(entry)))
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return arrived.length === 0 ? held : [...held, ...arrived];
}

const normalize = (value: string) => value.trim().toLowerCase();

/** Every chosen label must be on the issue, matching how the pull request filter combines them. */
export function matchesIssueFilters(entry: IssueListEntry, filters: IssueListFilters): boolean {
  const labels = new Set(entry.labels.map((label) => normalize(label.name)));
  return (
    (filters.labels === undefined ||
      filters.labels.every((label) => labels.has(normalize(label)))) &&
    (filters.author === undefined ||
      (entry.author !== null && normalize(entry.author.login) === normalize(filters.author)))
  );
}

/** Narrows rows already on screen while the typed text has not reached the hosts yet. */
export function matchesIssueQuery(entry: IssueListEntry, query: string): boolean {
  const text = normalize(query);
  if (text.length === 0) return true;
  const number = text.startsWith("#") ? text.slice(1) : text;
  return (
    normalize(entry.title).includes(text) ||
    normalize(entry.repository).includes(text) ||
    String(entry.number) === number ||
    entry.labels.some((label) => normalize(label.name).includes(text))
  );
}

export function collectIssueListFacets(entries: ReadonlyArray<IssueListEntry>): {
  readonly authors: ReadonlyArray<PullRequestAuthorFacet>;
  readonly labels: ReadonlyArray<PullRequestLabelFacet>;
} {
  const authors = new Map<string, PullRequestAuthorFacet>();
  const labels = new Map<string, PullRequestLabelFacet>();
  for (const entry of entries) {
    if (entry.author !== null) {
      const key = normalize(entry.author.login);
      const held = authors.get(key);
      authors.set(key, {
        actor: held?.actor ?? entry.author,
        count: (held?.count ?? 0) + 1,
        mergedCount: 0,
      });
    }
    for (const label of entry.labels) {
      const key = normalize(label.name);
      if (key.length === 0) continue;
      const held = labels.get(key);
      labels.set(key, { ...(held ?? label), count: (held?.count ?? 0) + 1 });
    }
  }
  return {
    authors: [...authors.values()].toSorted(
      (left, right) =>
        right.count - left.count || left.actor.login.localeCompare(right.actor.login),
    ),
    labels: [...labels.values()].toSorted(
      (left, right) => right.count - left.count || left.name.localeCompare(right.name),
    ),
  };
}

/** The chip an Ask thread opens with, worn like the pull request one: which issue, and its title. */
export function askAboutIssueContext(issue: HandoffIssue): ReviewCommentContext {
  return {
    id: `issue-context:${issue.number}`,
    sectionId: `issue:${issue.number}`,
    sectionTitle: `Issue #${issue.number}`,
    filePath: `Issue #${issue.number}`,
    startIndex: 0,
    endIndex: 0,
    rangeLabel: issue.title.replace(/\s+/gu, " ").trim().slice(0, 300),
    text: issueContextText(issue, ASK_ABOUT_ISSUE_INSTRUCTIONS),
    diff: "",
  };
}
