import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  issueHandoffMenuAction,
  issueHandoffProjects,
  parseIssueHandoffEvent,
} from "./issueHandoffActions";

const one = EnvironmentId.make("env-one");
const two = EnvironmentId.make("env-two");
function project(
  id: string,
  patch: Partial<EnvironmentProject> & { readonly repository?: string } = {},
): EnvironmentProject {
  const { repository = "org/repo", ...rest } = patch;
  const [owner, name] = repository.split("/");
  return {
    id: ProjectId.make(id),
    environmentId: one,
    title: id,
    workspaceRoot: `/work/${id}`,
    repositoryIdentity: {
      canonicalKey: `github.com/${repository}`,
      locator: { source: "git-remote", remoteName: "origin", remoteUrl: "" },
      provider: "github",
      owner,
      name,
    },
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...rest,
  } as EnvironmentProject;
}
const issue = {
  environmentId: one,
  projectId: ProjectId.make("listed"),
  host: "github.com",
  repository: "org/repo",
};

describe("issue handoff projects", () => {
  it("offers the repository's projects on the issue's environment, most recent first", () => {
    const projects = [
      project("older", { updatedAt: "2026-09-01T00:00:00.000Z" }),
      project("newer", { updatedAt: "2026-10-05T00:00:00.000Z" }),
      project("elsewhere", { environmentId: two }),
      project("unrelated", { repository: "org/other" }),
    ];
    expect(issueHandoffProjects(projects, issue).map((entry) => entry.id)).toEqual([
      "newer",
      "older",
    ]);
  });

  it("falls back to the project the issue was listed under when no identity matches", () => {
    const projects = [project("listed", { repositoryIdentity: null }), project("other")];
    expect(
      issueHandoffProjects(projects, { ...issue, repository: "org/unknown" }).map(
        (entry) => entry.id,
      ),
    ).toEqual(["listed"]);
  });
});

describe("issue handoff menu", () => {
  it("asks for a project only when there is a choice", () => {
    const single = issueHandoffMenuAction("send", [project("a")], "sparkles", false);
    expect(single).not.toHaveProperty("subactions");
    expect(single.attributes.disabled).toBe(false);
    const several = issueHandoffMenuAction("ask", [project("a"), project("b")], "q", false);
    expect(several.subactions?.map((action) => action.id)).toEqual(["ask:a", "ask:b"]);
    expect(issueHandoffMenuAction("send", [], "sparkles", false).attributes.disabled).toBe(true);
  });

  it("reads back the chosen action and project", () => {
    expect(parseIssueHandoffEvent("send")).toEqual({ mode: "send", projectId: undefined });
    expect(parseIssueHandoffEvent("ask:project:with:colons")).toEqual({
      mode: "ask",
      projectId: "project:with:colons",
    });
    expect(parseIssueHandoffEvent("share")).toBeNull();
  });
});
