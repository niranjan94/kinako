import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, IssueListInput, PullRequestListInput } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { use, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { composerPullRequests } from "../../state/pull-requests";
import { mergeEnvironmentIssuePages, type IssueListPages } from "./issueList";
import {
  appendPullRequestListPage,
  nextPullRequestListInput,
  pullRequestListHead,
} from "./pullRequestList";

const pagesFamily = Atom.family((_key: string) =>
  Atom.make<IssueListPages | null>(null).pipe(Atom.setIdleTTL(5 * 60_000)),
);

type IssueListTarget = { readonly environmentId: EnvironmentId; readonly input: IssueListInput };
const sourcesFamily = Atom.family((key: string) => {
  const targets: readonly IssueListTarget[] = JSON.parse(key);
  return Atom.make((get) =>
    targets.map((target) => {
      const result = get(composerPullRequests.issueList(target));
      const head = Option.getOrNull(AsyncResult.value(result));
      const cached = get(pagesFamily(JSON.stringify(target)));
      return { target, result, pages: head ? pullRequestListHead(cached, head) : cached };
    }),
  );
});

type PullRequestListTarget = {
  readonly environmentId: EnvironmentId;
  readonly input: PullRequestListInput;
};
const headsFamily = Atom.family((key: string) => {
  const targets: readonly PullRequestListTarget[] = JSON.parse(key);
  return Atom.make((get) =>
    targets.map((target) => ({
      environmentId: target.environmentId,
      head: Option.getOrNull(AsyncResult.value(get(composerPullRequests.list(target)))),
    })),
  );
});

/**
 * The first page of each pull request listing, which is where hosts report whether their issues
 * can be browsed and who the viewer is. Shares the pull request list's own query.
 */
export function usePullRequestListHeads(targets: readonly PullRequestListTarget[]) {
  return useAtomValue(headsFamily(JSON.stringify(targets)));
}

export function useIssueList(targets: readonly IssueListTarget[]) {
  const registry = use(RegistryContext);
  const scopeKey = JSON.stringify(targets);
  const activeScope = useRef(scopeKey);
  const sources = useAtomValue(sourcesFamily(scopeKey));
  const requests = useRef<{ page?: AbortController; refresh?: AbortController }>({});
  const [loading, setLoading] = useState({
    key: scopeKey,
    page: false,
    refresh: false,
    error: null as string | null,
  });
  const state = loading.key === scopeKey ? loading : { page: false, refresh: false, error: null };
  useLayoutEffect(() => {
    activeScope.current = scopeKey;
    return () => {
      requests.current.page?.abort();
      requests.current.refresh?.abort();
      requests.current = {};
    };
  }, [scopeKey, activeScope]);
  useEffect(() => {
    for (const { target, pages } of sources)
      if (pages) registry.set(pagesFamily(JSON.stringify(target)), pages);
  }, [registry, sources]);

  const loadMore = useCallback(
    async (retry = false) => {
      if (requests.current.page || requests.current.refresh || (!retry && state.error)) return;
      const continuations = targets.flatMap((target) => {
        const pagesAtom = pagesFamily(JSON.stringify(target));
        const pages = registry.get(pagesAtom);
        const input = pages && nextPullRequestListInput(pages, target.input);
        return pages && input ? [{ target, pagesAtom, pages, input }] : [];
      });
      if (!continuations.length) return;
      const controller = new AbortController();
      requests.current.page = controller;
      setLoading({ key: scopeKey, page: true, refresh: false, error: null });
      const responses = await Promise.allSettled(
        continuations.map(async ({ target, pagesAtom, pages, input }) => {
          const response = await executeAtomQuery(
            registry,
            composerPullRequests.issueList({ ...target, input }),
            { signal: controller.signal, refresh: retry, reportFailure: false },
          );
          if (controller.signal.aborted || activeScope.current !== scopeKey) return;
          if (response._tag === "Failure") throw squashAtomCommandFailure(response);
          if (response.value.errors.length)
            throw new Error(response.value.errors.map((error) => error.message).join("\n"));
          const next = appendPullRequestListPage(
            registry.get(pagesAtom) ?? pages,
            response.value,
            input,
          );
          registry.set(pagesAtom, next);
          if (
            input.cursors &&
            Object.keys(next.nextCursors).length &&
            JSON.stringify(Object.entries(input.cursors).sort()) ===
              JSON.stringify(Object.entries(next.nextCursors).sort())
          )
            throw new Error("Couldn't advance the list. Try again.");
        }),
      );
      if (requests.current.page === controller) delete requests.current.page;
      if (!controller.signal.aborted && activeScope.current === scopeKey)
        setLoading({ key: scopeKey, page: false, refresh: false, error: requestErrors(responses) });
    },
    [targets, registry, scopeKey, state.error, activeScope],
  );

  const onRefresh = async () => {
    if (!targets.length || requests.current.refresh) return;
    requests.current.page?.abort();
    delete requests.current.page;
    const controller = new AbortController();
    requests.current.refresh = controller;
    setLoading({ key: scopeKey, page: false, refresh: true, error: null });
    const responses = await Promise.allSettled(
      targets.map(async (target) => {
        await composerPullRequests.invalidate.run(registry, {
          environmentId: target.environmentId,
          input: {},
        });
        if (controller.signal.aborted) return;
        const response = await executeAtomQuery(registry, composerPullRequests.issueList(target), {
          refresh: true,
          signal: controller.signal,
          reportFailure: false,
        });
        if (controller.signal.aborted || activeScope.current !== scopeKey) return;
        if (response._tag === "Failure") throw squashAtomCommandFailure(response);
        registry.set(
          pagesFamily(JSON.stringify(target)),
          pullRequestListHead(null, response.value),
        );
      }),
    );
    if (requests.current.refresh === controller) delete requests.current.refresh;
    if (!controller.signal.aborted && activeScope.current === scopeKey)
      setLoading({ key: scopeKey, page: false, refresh: false, error: requestErrors(responses) });
  };

  const data = useMemo(
    () =>
      mergeEnvironmentIssuePages(
        sources.flatMap(({ target, pages }) =>
          pages ? [{ environmentId: target.environmentId, pages }] : [],
        ),
      ),
    [sources],
  );
  const errors = useMemo(
    () =>
      sources.flatMap(({ target, result }) => {
        if (result._tag !== "Failure") return [];
        const cause = Cause.squash(result.cause);
        return [
          {
            environmentId: target.environmentId,
            projectTitle: "",
            message: cause instanceof Error ? cause.message : "Couldn't load issues.",
          },
        ];
      }),
    [sources],
  );
  return {
    entries: data.entries,
    errors: useMemo(() => [...data.errors, ...errors], [data.errors, errors]),
    error: errors.map((error) => error.message).join("\n") || null,
    isPending: sources.some(({ result }) => result.waiting) && !data.entries.length,
    continued: data.continued,
    loadMore,
    onRefresh,
    refreshing: state.refresh,
    loadingMore: state.page,
    loadMoreError: state.error,
  };
}

function requestErrors(results: readonly PromiseSettledResult<unknown>[]) {
  return (
    results
      .flatMap((result) =>
        result.status === "rejected"
          ? [result.reason instanceof Error ? result.reason.message : "Couldn't load issues."]
          : [],
      )
      .join("\n") || null
  );
}
