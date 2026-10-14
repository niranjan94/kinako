import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  projectsForRepository,
  sendIssueToAgentPrompt,
  type HandoffIssue,
} from "@t3tools/client-runtime/issue-handoff";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { useComposerDraftStore, type DraftId } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { readProjects, readThreadShells } from "../../state/entities";
import { sortScopedProjectsForSidebar } from "../Sidebar.logic";
import { toastManager } from "../ui/toast";
import { askAboutIssueContext } from "./issue.logic";

/**
 * A question should not change anything without the reader agreeing first. ChatView reads a
 * local draft's mode from its session context rather than the composer, so both are set.
 */
export function requireApprovalForDraft(draftId: DraftId): void {
  const store = useComposerDraftStore.getState();
  store.setRuntimeMode(draftId, "approval-required");
  store.setDraftThreadContext(draftId, { runtimeMode: "approval-required" });
}

export type IssueHandoffProject = ReturnType<typeof readProjects>[number];

/** The checkouts of the issue's repository on the server it was read from, most recent first. */
export function readIssueHandoffProjects(item: {
  readonly environmentId: EnvironmentId;
  readonly host: string;
  readonly repository: string;
}): ReadonlyArray<IssueHandoffProject> {
  const projects = readProjects().filter(
    (project) => project.environmentId === item.environmentId && project.isScratch !== true,
  );
  return projectsForRepository(
    sortScopedProjectsForSidebar(projects, readThreadShells(), "updated_at"),
    item,
  );
}

export type IssueHandoffKind = "ask" | "send";

/** Opens a draft thread for an issue. Nothing is sent: the reader reads it over and sends. */
export function useIssueHandoff() {
  const newThread = useNewThreadHandler();
  const [pending, setPending] = useState<IssueHandoffKind | null>(null);
  const start = async (
    kind: IssueHandoffKind,
    issue: HandoffIssue,
    project: Pick<IssueHandoffProject, "environmentId" | "id">,
  ) => {
    if (pending !== null) return;
    setPending(kind);
    const opened = await newThread(scopeProjectRef(project.environmentId, project.id)).then(
      (session) => session,
      () => null,
    );
    setPending(null);
    if (opened === null) {
      toastManager.add({
        type: "error",
        title: "Could not open a thread",
        description: "Try again from the project, or open a thread first.",
      });
      return;
    }
    const store = useComposerDraftStore.getState();
    if (kind === "send") {
      store.setPrompt(opened.draftId, sendIssueToAgentPrompt(issue));
      toastManager.add({
        type: "success",
        title: "Issue ready in a new thread",
        description: "The task is in the composer. Read it over, then send.",
      });
      return;
    }
    store.setPrompt(opened.draftId, "");
    store.setReviewComments(opened.draftId, [askAboutIssueContext(issue)]);
    requireApprovalForDraft(opened.draftId);
    toastManager.add({
      type: "success",
      title: "Asked in a thread",
      description: "The issue is in the composer. Type your question, then send.",
    });
  };
  return { start, pending };
}
