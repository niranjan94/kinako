import type {
  EnvironmentId,
  IssueListEntry,
  IssueListResult,
  IssueListState,
  PullRequestListResult,
} from "@t3tools/contracts";
import {
  matchesListAuthorAndLabels,
  pullRequestListKey,
  uniqueSortedListEntries,
  type ListPages,
  type PullRequestListControls,
} from "./pullRequestList";

export type IssueListPages = ListPages<IssueListResult>;

export type EnvironmentIssueListEntry = IssueListEntry & {
  readonly environmentId: EnvironmentId;
};

export const scopedIssueListKey = (entry: EnvironmentIssueListEntry) =>
  `${entry.environmentId}:${pullRequestListKey(entry)}`;

/** Issues are never merged; the pull request list's "Merged" reads as closed here. */
export function issueListState(state: PullRequestListControls["state"]): IssueListState {
  return state === "merged" ? "closed" : state;
}

/**
 * Only GitHub hosts browse issues, and only the pull request listing says which hosts those are.
 * An environment whose listing has not loaded yet is assumed able to, so a restored Issues view
 * does not flicker back to pull requests while that listing arrives.
 */
export function issueBrowsingEnvironments(
  heads: readonly {
    readonly environmentId: EnvironmentId;
    readonly head: Pick<PullRequestListResult, "providers"> | null;
  }[],
) {
  const environments = new Set<EnvironmentId>();
  let available = false;
  let pending = false;
  for (const { environmentId, head } of heads) {
    if (!head) {
      environments.add(environmentId);
      pending = true;
    } else if (head.providers.some((provider) => provider.issues === true)) {
      environments.add(environmentId);
      available = true;
    }
  }
  return { environments, available, pending };
}

/** Provider refreshes recreate entries; unchanged rows can stay mounted. */
export function issueListRowsAreEqual(
  previous: EnvironmentIssueListEntry,
  next: EnvironmentIssueListEntry,
) {
  return (
    previous === next ||
    (previous.environmentId === next.environmentId &&
      previous.projectId === next.projectId &&
      previous.host === next.host &&
      previous.repository === next.repository &&
      previous.number === next.number &&
      previous.title === next.title &&
      previous.url === next.url &&
      previous.state === next.state &&
      previous.updatedAt === next.updatedAt &&
      previous.commentCount === next.commentCount &&
      previous.author?.login === next.author?.login &&
      previous.author?.avatarUrl === next.author?.avatarUrl &&
      previous.labels.length === next.labels.length &&
      previous.labels.every(
        (label, index) =>
          label.name === next.labels[index]?.name && label.color === next.labels[index]?.color,
      ))
  );
}

/** Keep cursors and errors with the environment that issued them. */
export function mergeEnvironmentIssuePages(
  sources: readonly { environmentId: EnvironmentId; pages: IssueListPages }[],
) {
  const entries: EnvironmentIssueListEntry[] = [];
  const errors = [];
  for (const { environmentId, pages } of sources) {
    entries.push(...pages.entries.map((entry) => ({ ...entry, environmentId })));
    errors.push(...pages.head.errors.map((error) => ({ ...error, environmentId })));
  }
  return { entries, errors, continued: sources.some(({ pages }) => pages.continued) };
}

/**
 * The host already applied the state and search. Project, author and label filters are shared
 * with the pull request list and apply here to the fields an issue also has.
 */
export function filterIssueList<Entry extends IssueListEntry & { environmentId?: string }>(
  entries: readonly Entry[],
  controls: PullRequestListControls,
  viewers: PullRequestListResult["viewers"],
  connectedEnvironmentIds?: ReadonlySet<string>,
) {
  const state = issueListState(controls.state);
  const filtered = entries.filter((entry) => {
    if (state !== "all" && entry.state !== state) return false;
    if (controls.projectId && entry.projectId !== controls.projectId) return false;
    if (controls.projectEnvironmentId && entry.environmentId !== controls.projectEnvironmentId)
      return false;
    const viewerKey = entry.environmentId ? `${entry.environmentId} ${entry.host}` : entry.host;
    return matchesListAuthorAndLabels(entry, controls.filters, viewers[viewerKey]);
  });
  return uniqueSortedListEntries(filtered, controls.sort, connectedEnvironmentIds);
}
