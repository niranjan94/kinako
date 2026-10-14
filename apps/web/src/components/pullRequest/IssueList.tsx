import type { EnvironmentId } from "@t3tools/contracts";

import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Spinner } from "../ui/spinner";
import { IssueRow } from "./IssueRow";
import { issueEntryKey, type EnvironmentIssueEntry } from "./issue.logic";
import { PullRequestListGhost } from "./PullRequestGhosts";
import { ISSUE_STATE_PRESENTATION } from "./pullRequestIcons";
import { PullRequestsUnavailableState } from "./PullRequestsUnavailableState";

/** What the issues kind of the list shows: its rows, or the reason it has none. */
export function IssueListBody({
  entries,
  firstLoad,
  error,
  refreshing,
  filtered,
  truncated,
  canLoadMore,
  loadingMore,
  selectedKey,
  environmentLabels,
  onSelect,
  onRetry,
  onLoadMore,
}: {
  entries: ReadonlyArray<EnvironmentIssueEntry>;
  firstLoad: boolean;
  error: string | null;
  refreshing: boolean;
  /** Something narrows the list, so an empty answer says so rather than "no issues". */
  filtered: boolean;
  truncated: boolean;
  canLoadMore: boolean;
  loadingMore: boolean;
  selectedKey: string | null;
  /** Present only where the list spans more than one server. */
  environmentLabels: ReadonlyMap<EnvironmentId, string> | null;
  onSelect: (entry: EnvironmentIssueEntry) => void;
  onRetry: () => void;
  onLoadMore: () => void;
}) {
  if (firstLoad) return <PullRequestListGhost rows={7} />;
  if (error !== null && entries.length === 0) {
    return (
      <PullRequestsUnavailableState
        title="Could not load issues"
        error={error}
        refreshing={refreshing}
        onRetry={onRetry}
      />
    );
  }
  if (entries.length === 0) {
    const Icon = ISSUE_STATE_PRESENTATION.open.Icon;
    return (
      <Empty>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>{filtered ? "No matching issues" : "No issues"}</EmptyTitle>
          <EmptyDescription>
            {filtered
              ? "Nothing here matches these filters. Widen them to see more."
              : "Issues from your GitHub projects show up here."}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <>
      <div className="space-y-0.5">
        {entries.map((entry) => {
          const key = issueEntryKey(entry);
          const label = environmentLabels?.get(entry.environmentId);
          return (
            <IssueRow
              key={key}
              entry={entry}
              selected={key === selectedKey}
              onSelect={onSelect}
              {...(label === undefined ? {} : { environmentLabel: label })}
            />
          );
        })}
      </div>
      {error !== null ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning-surface px-3 py-2 text-xs">
          <span>{error} Showing the last issues loaded.</span>
          <Button size="xs" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : null}
      {truncated ? (
        <div className="flex justify-center py-3 text-xs text-muted-foreground">
          {loadingMore ? (
            <span className="flex items-center gap-2">
              <Spinner aria-hidden size="sm" />
              Loading more
            </span>
          ) : canLoadMore ? (
            <Button size="sm" variant="outline" onClick={onLoadMore}>
              Load more issues
            </Button>
          ) : (
            <span>Narrow your search to find more issues.</span>
          )}
        </div>
      ) : null}
    </>
  );
}
