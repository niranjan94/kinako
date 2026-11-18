import { StackActions, useNavigation } from "@react-navigation/native";
import {
  askAboutIssueContext,
  sendIssueToAgentPrompt,
  type HandoffIssue,
} from "@t3tools/client-runtime/issue-handoff";
import {
  AuthOrchestrationOperateScope,
  COMPOSER_CONTEXT_REVIEW_TEXT_MAX_CHARS,
  ComposerContextId,
  type EnvironmentId,
  type ProjectId,
  type ReviewCommentContextRecord,
} from "@t3tools/contracts";
import {
  formatComposerContextReference,
  sanitizeComposerContextLabel,
} from "@t3tools/shared/composerContextReferences";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { useGT } from "gt-react-native";
import { useRef, useState } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironmentScope } from "../../state/session";
import {
  createNewTaskDraft,
  insertComposerDraftContext,
  setComposerDraftText,
  updateComposerDraftSettings,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import { usePullRequestConnected } from "../pull-requests/usePullRequestConnected";

export type IssueHandoffKind = "send" | "ask";

/**
 * Hands an issue to an agent as a new task draft in the issue's project. Nothing is sent: the
 * user reviews the draft, and Ask starts supervised because the issue's text is untrusted.
 */
export function useIssueHandoff(params: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const gt = useGT();
  const navigation = useNavigation();
  const connected = usePullRequestConnected(params.environmentId);
  const canOperate = useEnvironmentScope(params.environmentId, AuthOrchestrationOperateScope);
  // Composing offline only writes a local draft. The outbox checks grants on delivery.
  const canStart = !connected || canOperate;
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);

  const start = async (kind: IssueHandoffKind, issue: HandoffIssue) => {
    if (pending.current || !canStart) return;
    pending.current = true;
    setBusy(true);
    const result = await settlePromise(async () => {
      await waitForComposerDraftsLoaded();
      const draftKey = createNewTaskDraft({
        environmentId: params.environmentId,
        projectId: params.projectId,
      });
      if (kind === "send") setComposerDraftText(draftKey, sendIssueToAgentPrompt(issue));
      else {
        updateComposerDraftSettings(draftKey, { runtimeMode: "approval-required" });
        const fields = askAboutIssueContext(issue);
        const context: ReviewCommentContextRecord = {
          version: 1,
          kind: "review-comment",
          contextId: ComposerContextId.make(uuidv4()),
          label: sanitizeComposerContextLabel(issue.displayKey, "issue"),
          ...fields,
          text: fields.text.slice(0, COMPOSER_CONTEXT_REVIEW_TEXT_MAX_CHARS),
        };
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
          throw new Error(gt("Couldn't attach the issue to a new draft."));
      }
      navigation.dispatch(
        StackActions.push("Thread", {
          draft: {
            draftId: draftKey,
            title:
              kind === "ask"
                ? gt("Ask about {issue}", { issue: issue.displayKey })
                : gt("Issue {issue}", { issue: issue.displayKey }),
          },
        }),
      );
    });
    pending.current = false;
    setBusy(false);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      Dialog.alert(
        gt("Couldn't open a thread"),
        cause instanceof Error ? cause.message : gt("Try again."),
      );
    }
  };

  return { canStart, busy, start };
}
