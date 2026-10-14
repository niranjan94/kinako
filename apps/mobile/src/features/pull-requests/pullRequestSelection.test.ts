import { describe, expect, it } from "vite-plus/test";
import type { NavigationState } from "@react-navigation/native";
import { selectedPullRequestKey } from "./pullRequestSelection";

const params = {
  environmentId: "environment-one",
  projectId: "project-one",
  host: "GitHub.COM",
  repository: "Org/Repo",
  number: 42,
};
const home = { key: "home", name: "Home" };
const pullRequest = { key: "pr", name: "PullRequest", params };
function selection(routes: NavigationState["routes"], index = routes.length - 1) {
  return selectedPullRequestKey({ routes, index });
}

describe("displayed pull request selection", () => {
  it("normalizes repository and host while retaining the environment scope", () => {
    expect(selection([home, pullRequest])).toBe("environment-one:github.com:org/repo:42");
    expect(
      selection([
        home,
        { ...pullRequest, params: { ...params, environmentId: "environment-two" } },
      ]),
    ).toBe("environment-two:github.com:org/repo:42");
  });

  it.each([
    "PullRequestFile",
    "PullRequestFiles",
    "PullRequestGuideStop",
    "PullRequestDiscussion",
    "PullRequestReviewers",
    "PullRequestReview",
    "PullRequestInlineComment",
  ])("keeps the owning selection on %s", (name) => {
    expect(selection([home, pullRequest, { key: name, name, params }])).toBe(
      "environment-one:github.com:org/repo:42",
    );
  });

  it("uses the most recently opened PR, including a different hosting service", () => {
    expect(
      selection([
        home,
        pullRequest,
        {
          key: "other-pr",
          name: "PullRequest",
          params: { ...params, host: "github.enterprise", repository: "Other/Repo", number: 7 },
        },
      ]),
    ).toBe("environment-one:github.enterprise:other/repo:7");
  });

  it.each(["Home", "Thread", "ThreadFiles"])("clears an older selection on %s", (name) => {
    expect(selection([home, pullRequest, { key: "current", name }])).toBeNull();
  });

  it("ignores inactive routes after the navigation index", () => {
    expect(selection([home, pullRequest], 0)).toBeNull();
  });

  it("retains the owning PR behind an unrelated overlay", () => {
    expect(selection([home, pullRequest, { key: "settings", name: "SettingsSheet" }])).toBe(
      "environment-one:github.com:org/repo:42",
    );
  });

  it("does not highlight an older PR when the current PR lacks its hosting identity", () => {
    expect(
      selection([
        home,
        pullRequest,
        { key: "unresolved", name: "PullRequest", params: { environmentId: "environment-one" } },
      ]),
    ).toBeNull();
  });

  it("highlights an issue, including behind its comment sheet", () => {
    const issue = { key: "issue", name: "Issue", params: { ...params, number: 43 } };
    expect(selection([home, issue])).toBe("environment-one:github.com:org/repo:43");
    expect(
      selection([home, issue, { key: "comment", name: "IssueComment", params: issue.params }]),
    ).toBe("environment-one:github.com:org/repo:43");
  });

  it("follows the most recent of a pull request and an issue", () => {
    const issue = { key: "issue", name: "Issue", params: { ...params, number: 43 } };
    expect(selection([home, pullRequest, issue])).toBe("environment-one:github.com:org/repo:43");
    expect(selection([home, issue, pullRequest])).toBe("environment-one:github.com:org/repo:42");
  });

  it("does not highlight an older PR when the current issue lacks its hosting identity", () => {
    expect(
      selection([
        home,
        pullRequest,
        { key: "unresolved", name: "Issue", params: { environmentId: "environment-one" } },
      ]),
    ).toBeNull();
  });
});
