import {
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  type IssueListEntry,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  appendIssuePage,
  askAboutIssueContext,
  collectIssueListFacets,
  issueEntryKey,
  issueListStateOf,
  matchesIssueFilters,
  matchesIssueQuery,
  mergeIssueLists,
  type EnvironmentIssueEntry,
} from "./issue.logic";

const laptop = EnvironmentId.make("env-laptop");
const server = EnvironmentId.make("env-server");

function issue(number: number, overrides: Partial<IssueListEntry> = {}): IssueListEntry {
  return {
    provider: SourceControlProviderKind.make("github"),
    host: "github.com",
    projectId: ProjectId.make("project"),
    projectTitle: "web",
    repository: "acme/web",
    number,
    title: `Issue ${number}`,
    url: `https://github.com/acme/web/issues/${number}`,
    author: { login: "octocat", name: null, avatarUrl: null },
    state: "open",
    labels: [],
    assignees: [],
    commentCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: `2026-01-${String(number).padStart(2, "0")}T00:00:00.000Z`,
    closedAt: null,
    ...overrides,
  };
}

const scoped = (environmentId: EnvironmentId, entry: IssueListEntry): EnvironmentIssueEntry => ({
  ...entry,
  environmentId,
});

describe("mergeIssueLists", () => {
  it("unions environments newest first and keeps each environment's continuation", () => {
    const merged = mergeIssueLists([
      [
        laptop,
        {
          entries: [issue(3)],
          errors: [],
          truncated: true,
          nextCursors: { "acme/web": "c1" },
        },
      ],
      [
        server,
        {
          entries: [issue(9, { repository: "acme/api" })],
          errors: [{ projectId: ProjectId.make("api"), projectTitle: "api", message: "no access" }],
          truncated: false,
          nextCursors: {},
        },
      ],
    ]);
    expect(merged?.entries.map((entry) => [entry.environmentId, entry.number])).toEqual([
      [server, 9],
      [laptop, 3],
    ]);
    expect(merged?.truncated).toBe(true);
    expect(merged?.nextCursors).toEqual({ [laptop]: { "acme/web": "c1" } });
    expect(merged?.errors.map((error) => error.environmentId)).toEqual([server]);
  });

  it("has nothing to say before any environment answers", () => {
    expect(mergeIssueLists([])).toBeNull();
  });
});

describe("appendIssuePage", () => {
  it("keeps held rows in place and appends only new ones, newest first", () => {
    const held = [scoped(laptop, issue(5)), scoped(laptop, issue(4))];
    const page = [scoped(laptop, issue(4)), scoped(laptop, issue(1)), scoped(server, issue(2))];
    expect(appendIssuePage(held, page).map(issueEntryKey)).toEqual([
      issueEntryKey(held[0]!),
      issueEntryKey(held[1]!),
      issueEntryKey(scoped(server, issue(2))),
      issueEntryKey(scoped(laptop, issue(1))),
    ]);
  });

  it("returns the held list itself when the slice adds nothing", () => {
    const held = [scoped(laptop, issue(5))];
    expect(appendIssuePage(held, [scoped(laptop, issue(5))])).toBe(held);
  });
});

describe("issue filters", () => {
  const labelled = issue(1, {
    author: { login: "Octocat", name: null, avatarUrl: null },
    labels: [
      { name: "bug", color: null },
      { name: "Needs Triage", color: "ff0000" },
    ],
  });

  it("requires every chosen label, ignoring case", () => {
    expect(matchesIssueFilters(labelled, { labels: ["BUG", "needs triage"] })).toBe(true);
    expect(matchesIssueFilters(labelled, { labels: ["bug", "docs"] })).toBe(false);
  });

  it("matches the author login without regard to case and drops authorless issues", () => {
    expect(matchesIssueFilters(labelled, { author: "octocat" })).toBe(true);
    expect(matchesIssueFilters(issue(2, { author: null }), { author: "octocat" })).toBe(false);
  });

  it("narrows by title, repository, number or label while a search is on its way", () => {
    expect(matchesIssueQuery(labelled, "issue 1")).toBe(true);
    expect(matchesIssueQuery(labelled, "#1")).toBe(true);
    expect(matchesIssueQuery(labelled, "triage")).toBe(true);
    expect(matchesIssueQuery(labelled, "acme/api")).toBe(false);
  });

  it("maps the merged pull request state onto closed issues", () => {
    expect(issueListStateOf("merged")).toBe("closed");
    expect(issueListStateOf("open")).toBe("open");
    expect(issueListStateOf("all")).toBe("all");
  });

  it("counts authors and labels across the rows", () => {
    const facets = collectIssueListFacets([
      labelled,
      issue(2, { labels: [{ name: "Bug", color: null }] }),
    ]);
    expect(facets.authors.map((author) => [author.actor.login, author.count])).toEqual([
      ["Octocat", 2],
    ]);
    expect(facets.labels.map((label) => [label.name, label.count])).toEqual([
      ["bug", 2],
      ["Needs Triage", 1],
    ]);
  });
});

describe("askAboutIssueContext", () => {
  it("names the issue as untrusted reference data with the question instructions", () => {
    const context = askAboutIssueContext({
      repository: "acme/web",
      number: 7,
      title: "Crash on   launch",
      url: "https://github.com/acme/web/issues/7",
      state: "open",
    });
    expect(context.id).toBe("issue-context:7");
    expect(context.filePath).toBe("Issue #7");
    expect(context.rangeLabel).toBe("Crash on launch");
    expect(context.pullRequest).toBeUndefined();
    expect(context.text).toContain("acme/web#7");
    expect(context.text).toContain("untrusted data");
    expect(context.text).toContain("Do not change any code");
  });
});
