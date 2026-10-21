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
