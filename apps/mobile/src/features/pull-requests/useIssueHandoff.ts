import { useNavigation } from "@react-navigation/native";
import { sendIssueToAgentPrompt } from "@t3tools/client-runtime/issue-handoff";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { useCallback, useMemo, useRef, useState } from "react";
import { Alert } from "react-native";
import { issueComposerContext } from "../../lib/composerContext";
import { uuidv4 } from "../../lib/uuid";
import { useProjects } from "../../state/entities";
import { useEnvironmentsWithScope } from "../../state/session";
import {
  createNewTaskDraft,
  insertComposerDraftContext,
  setComposerDraftText,
  updateComposerDraftSettings,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import { useWorkspaceEnvironments } from "../../state/workspace";
import {
  issueHandoffProjects,
  type HandoffIssueItem,
  type IssueHandoffMode,
} from "./issueHandoffActions";

/**
 * Hands an issue to an agent as a new task draft. Nothing is sent: the user reviews the draft,
 * and Ask starts supervised because the issue's text is untrusted.
 */
export function useIssueHandoff() {
  const navigation = useNavigation();
  const projects = useProjects();
  const environments = useWorkspaceEnvironments();
  const operable = useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const offline = useMemo(
    () =>
      new Set(
        environments
          .filter((environment) => environment.connectionState !== "connected")
          .map((environment) => environment.environmentId),
      ),
    [environments],
  );
  // Composing offline only writes a local draft. The outbox checks grants on delivery.
  const canStart = useCallback(
    (environmentId: EnvironmentId) => offline.has(environmentId) || operable.has(environmentId),
    [offline, operable],
  );
  const projectsFor = useCallback(
    (issue: Pick<HandoffIssueItem, "environmentId" | "projectId" | "host" | "repository">) =>
      issueHandoffProjects(projects, issue),
    [projects],
  );
  const start = useCallback(
    async (mode: IssueHandoffMode, issue: HandoffIssueItem, projectId?: string) => {
      if (pending.current || !canStart(issue.environmentId)) return;
      const project =
        projectsFor(issue).find((candidate) => !projectId || candidate.id === projectId) ?? null;
      if (!project) {
        Alert.alert(
          "No project for this repository",
          `Add ${issue.repository} as a project on this environment, then try again.`,
        );
        return;
      }
      pending.current = true;
      setBusy(true);
      try {
        await waitForComposerDraftsLoaded();
        const draftKey = createNewTaskDraft({
          environmentId: issue.environmentId,
          projectId: project.id,
        });
        if (mode === "send") setComposerDraftText(draftKey, sendIssueToAgentPrompt(issue));
        else {
          updateComposerDraftSettings(draftKey, { runtimeMode: "approval-required" });
          const context = issueComposerContext(issue, uuidv4());
          if (
            !insertComposerDraftContext(
              draftKey,
              {
                text: `${formatComposerContextReference(context)} `,
                context: { version: 1, records: [context] },
              },
              { text: "", start: 0, end: 0 },
            )
          )
            throw new Error("Couldn't attach the issue to a new draft.");
        }
        navigation.navigate("NewTaskSheet", {
          screen: "NewTaskDraft",
          params: {
            draftId: draftKey,
            title: mode === "ask" ? `Ask about #${issue.number}` : `Issue #${issue.number}`,
          },
        });
      } catch (cause) {
        Alert.alert("Couldn't start a task", cause instanceof Error ? cause.message : "Try again.");
      } finally {
        pending.current = false;
        setBusy(false);
      }
    },
    [canStart, projectsFor, navigation],
  );
  return { busy, canStart, projectsFor, start };
}
