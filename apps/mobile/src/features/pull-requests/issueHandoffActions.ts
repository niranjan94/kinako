import { projectsForRepository, type HandoffIssue } from "@t3tools/client-runtime/issue-handoff";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

export type IssueHandoffMode = "send" | "ask";

export type HandoffIssueItem = HandoffIssue & {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly host: string;
};

/** The projects an issue's repository is checked out as on its environment, most recent first. */
export function issueHandoffProjects(
  projects: readonly EnvironmentProject[],
  issue: Pick<HandoffIssueItem, "environmentId" | "projectId" | "host" | "repository">,
) {
  const local = projects
    .filter((project) => project.environmentId === issue.environmentId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const matches = projectsForRepository(local, issue);
  if (matches.length) return matches;
  return local.filter((project) => project.id === issue.projectId);
}

/** One menu entry per project an issue could be handed to. */
export function issueHandoffProjectActions(
  mode: IssueHandoffMode,
  projects: readonly Pick<EnvironmentProject, "id" | "title" | "workspaceRoot">[],
) {
  return projects.map((project) => ({
    id: `${mode}:${project.id}`,
    title: project.title,
    subtitle: project.workspaceRoot,
  }));
}

/** Menu entries for one handoff: a single action, or one per project when there is a choice. */
export function issueHandoffMenuAction(
  mode: IssueHandoffMode,
  projects: readonly Pick<EnvironmentProject, "id" | "title" | "workspaceRoot">[],
  image: string,
  disabled: boolean,
) {
  return {
    id: mode,
    title: mode === "send" ? "Send to agent" : "Ask about issue",
    image,
    attributes: { disabled: disabled || projects.length === 0 },
    ...(projects.length > 1 ? { subactions: issueHandoffProjectActions(mode, projects) } : {}),
  };
}

/** Reads a menu event produced by `issueHandoffMenuAction`. */
export function parseIssueHandoffEvent(event: string) {
  const [mode, ...rest] = event.split(":");
  if (mode !== "send" && mode !== "ask") return null;
  const projectId = rest.join(":");
  return { mode, projectId: projectId || undefined } as const;
}
