import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  SourceControlProviderKind,
  type IssueListEntry,
  type IssueListResult,
  type PullRequestProviderSummary,
} from "@t3tools/contracts";
import {
  filterIssueList,
  issueBrowsingEnvironments,
  issueListRowsAreEqual,
  issueListState,
  mergeEnvironmentIssuePages,
} from "./issueList";
import {
  appendPullRequestListPage,
  DEFAULT_PR_LIST_CONTROLS,
  nextPullRequestListInput,
  pullRequestListHead,
} from "./pullRequestList";

function issue(number: number, patch: Partial<IssueListEntry> = {}): IssueListEntry {
  return {
    provider: SourceControlProviderKind.make("github"),
    host: "github.com",
    projectId: "project" as IssueListEntry["projectId"],
    projectTitle: "Project",
    repository: "org/repo",
    number,
    title: `Issue ${number}`,
    url: `https://github.com/org/repo/issues/${number}`,
    author: { login: "octocat", name: null, avatarUrl: null },
    state: "open",
    labels: [],
    assignees: [],
    commentCount: 0,
    createdAt: `2026-09-${String(number).padStart(2, "0")}T00:00:00Z`,
    updatedAt: `2026-10-${String(number).padStart(2, "0")}T00:00:00Z`,
    closedAt: null,
    observedAt: 1,
    ...patch,
  };
}
function page(
  entries: readonly IssueListEntry[],
  nextCursors: IssueListResult["nextCursors"] = {},
): IssueListResult {
  return { entries, nextCursors, truncated: Object.keys(nextCursors).length > 0, errors: [] };
}
const one = EnvironmentId.make("env-one");
const two = EnvironmentId.make("env-two");
const provider = (issues?: boolean): PullRequestProviderSummary => ({
  host: "github.com",
  kind: SourceControlProviderKind.make("github"),
  searchesOnHost: true,
  ...(issues === undefined ? {} : { issues }),
  projectCount: 1,
  configured: true,
  detail: null,
});

describe("issue list paging", () => {
  it("continues each repository from its own cursor and stops at the end", () => {
    const first = pullRequestListHead(null, page([issue(3)], { "github.com org/repo": "next" }));
    const input = { state: "open" as const };
    const next = nextPullRequestListInput(first, input);
    expect(next).toEqual({ state: "open", limit: 30, cursors: { "github.com org/repo": "next" } });
    const appended = appendPullRequestListPage(first, page([issue(2), issue(3)]), next!);
    expect(appended.entries.map((row) => row.number)).toEqual([3, 2]);
    expect(nextPullRequestListInput(appended, input)).toBeNull();
  });

  it("keeps each environment's rows and errors with that environment", () => {
    const merged = mergeEnvironmentIssuePages([
      { environmentId: one, pages: pullRequestListHead(null, page([issue(1)])) },
      {
        environmentId: two,
        pages: pullRequestListHead(null, {
          ...page([issue(2)]),
          errors: [
            {
              projectId: "project" as IssueListEntry["projectId"],
              projectTitle: "Project",
              message: "No access",
            },
          ],
        }),
      },
    ]);
    expect(merged.entries.map((row) => [row.environmentId, row.number])).toEqual([
      [one, 1],
      [two, 2],
    ]);
    expect(merged.errors).toEqual([expect.objectContaining({ environmentId: two })]);
  });
});

describe("issue list filters", () => {
  it("reads the pull request list's Merged state as Closed", () => {
    expect(issueListState("merged")).toBe("closed");
    expect(issueListState("all")).toBe("all");
    const rows = [issue(1), issue(2, { state: "closed" })];
    expect(
      filterIssueList(rows, { ...DEFAULT_PR_LIST_CONTROLS, state: "merged" }, {}).map(
        (row) => row.number,
      ),
    ).toEqual([2]);
  });

  it("applies the shared author, label and project filters", () => {
    const rows = [
      { ...issue(1, { labels: [{ name: "Bug", color: null }] }), environmentId: one },
      {
        ...issue(2, { author: { login: "someone", name: null, avatarUrl: null } }),
        environmentId: one,
      },
      {
        ...issue(3, { projectId: "other" as IssueListEntry["projectId"], repository: "org/other" }),
        environmentId: one,
      },
    ];
    const numbers = (filters: Partial<typeof DEFAULT_PR_LIST_CONTROLS>) =>
      filterIssueList(
        rows,
        { ...DEFAULT_PR_LIST_CONTROLS, ...filters },
        { "env-one github.com": "someone" },
      ).map((row) => row.number);
    expect(numbers({ filters: { labels: [["bug"]] } })).toEqual([1]);
    expect(numbers({ filters: { excludedLabels: ["bug"] } })).toEqual([3, 2]);
    expect(numbers({ filters: { author: "me" } })).toEqual([2]);
    expect(numbers({ projectId: "other" })).toEqual([3]);
    expect(numbers({ sort: "created" })).toEqual([3, 2, 1]);
    expect(numbers({ sort: "oldest" })).toEqual([1, 2, 3]);
  });

  it("shows a repository available on two machines once, from a reachable one", () => {
    const rows = [
      { ...issue(1), environmentId: one },
      { ...issue(1), environmentId: two },
    ];
    expect(
      filterIssueList(rows, DEFAULT_PR_LIST_CONTROLS, {}, new Set([two])).map(
        (row) => row.environmentId,
      ),
    ).toEqual([two]);
  });
});

describe("issue browsing availability", () => {
  it("offers issues only where a host says they can be browsed", () => {
    const result = issueBrowsingEnvironments([
      { environmentId: one, head: { providers: [provider(true)] } },
      { environmentId: two, head: { providers: [provider()] } },
    ]);
    expect([...result.environments]).toEqual([one]);
    expect(result).toMatchObject({ available: true, pending: false });
    expect(
      issueBrowsingEnvironments([{ environmentId: two, head: { providers: [provider(false)] } }]),
    ).toMatchObject({ available: false, pending: false });
  });

  it("keeps an environment whose pull request listing has not loaded yet", () => {
    const result = issueBrowsingEnvironments([{ environmentId: one, head: null }]);
    expect([...result.environments]).toEqual([one]);
    expect(result).toMatchObject({ available: false, pending: true });
  });
});

describe("recycled issue rows", () => {
  it("keeps an unchanged row through refreshes and replaces a changed one", () => {
    const row = { ...issue(1, { labels: [{ name: "bug", color: "ff0000" }] }), environmentId: one };
    expect(
      issueListRowsAreEqual(row, {
        ...row,
        labels: row.labels.map((label) => ({ ...label })),
        observedAt: 9,
      }),
    ).toBe(true);
    expect(issueListRowsAreEqual(row, { ...row, commentCount: 1 })).toBe(false);
    expect(issueListRowsAreEqual(row, { ...row, state: "closed" })).toBe(false);
  });
});
