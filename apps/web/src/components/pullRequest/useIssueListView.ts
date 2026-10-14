import type {
  EnvironmentId,
  IssueListInput,
  IssueListState,
  ProjectId,
  PullRequestListCursors,
} from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

import { useIssueList, type EnvironmentQueryTarget } from "../../state/pullRequests";
import { appendIssuePage, type EnvironmentIssueEntry } from "./issue.logic";

/** The same single host page the pull request list asks for. */
const PAGE_SIZE = 99;
const NO_TARGETS: ReadonlyArray<EnvironmentQueryTarget<IssueListInput>> = [];

/**
 * The issue listing across the page's environments, a page at a time. A continuation asks only
 * the environments that said where to carry on from, and its rows land under those already held.
 */
export function useIssueListView({
  enabled,
  environmentQueries,
  state,
  projectId,
  host,
  query,
}: {
  enabled: boolean;
  environmentQueries: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectIds?: ReadonlyArray<ProjectId>;
  }>;
  state: IssueListState;
  projectId: ProjectId | undefined;
  host: string | undefined;
  query: string;
}) {
  const firstPageTargets = useMemo(
    () =>
      enabled
        ? environmentQueries.map(({ environmentId, projectIds }) => ({
            environmentId,
            input: {
              state,
              limit: PAGE_SIZE,
              ...(projectId ? { projectId } : {}),
              ...(projectIds ? { projectIds } : {}),
              ...(host ? { host } : {}),
              ...(query ? { query } : {}),
            } satisfies IssueListInput,
          }))
        : NO_TARGETS,
    [enabled, environmentQueries, host, projectId, query, state],
  );
  const filterKey = useMemo(() => JSON.stringify(firstPageTargets), [firstPageTargets]);
  const [page, setPage] = useState<{
    readonly key: string;
    readonly cursors: Readonly<Record<string, PullRequestListCursors>> | null;
  }>({ key: filterKey, cursors: null });
  const cursors = page.key === filterKey ? page.cursors : null;
  const targets = useMemo(
    () =>
      cursors === null
        ? firstPageTargets
        : firstPageTargets.flatMap((target) => {
            const next = cursors[target.environmentId];
            return next === undefined
              ? []
              : [{ ...target, input: { ...target.input, cursors: next } }];
          }),
    [cursors, firstPageTargets],
  );
  const list = useIssueList(targets);
  const [held, setHeld] = useState<{
    readonly key: string;
    readonly entries: ReadonlyArray<EnvironmentIssueEntry>;
  } | null>(null);
  useEffect(() => {
    if (list.data === null || list.isPending) return;
    const answer = list.data.entries;
    setHeld((previous) =>
      cursors !== null && previous?.key === filterKey
        ? { key: filterKey, entries: appendIssuePage(previous.entries, answer) }
        : { key: filterKey, entries: answer },
    );
  }, [cursors, filterKey, list.data, list.isPending]);

  const entries =
    held?.key === filterKey ? held.entries : cursors === null ? (list.data?.entries ?? []) : [];
  const nextCursors = list.data?.nextCursors ?? {};
  const canLoadMore = !list.isPending && Object.keys(nextCursors).length > 0;
  return {
    entries,
    errors: list.data?.errors ?? [],
    error: list.error,
    isPending: list.isPending,
    firstLoad: list.isPending && entries.length === 0 && held?.key !== filterKey,
    loadingMore: list.isPending && cursors !== null,
    truncated: list.data?.truncated === true,
    paged: cursors !== null,
    canLoadMore,
    loadMore: () => {
      if (canLoadMore) setPage({ key: filterKey, cursors: nextCursors });
    },
    /** Back to the first page, read again, since a continuation cannot refresh what came before it. */
    refresh: () => {
      setPage({ key: filterKey, cursors: null });
      list.refresh(firstPageTargets);
    },
  };
}
