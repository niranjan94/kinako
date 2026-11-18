import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  askAboutIssueContext,
  sendIssueToAgentPrompt,
  type HandoffIssue,
} from "@t3tools/client-runtime/issue-handoff";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { BotIcon, MessageCircleQuestionIcon } from "lucide-react";
import { msg, useGT } from "gt-react";
import { useState } from "react";

import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { m } from "~/i18n/messages";
import { useEnvironmentScope } from "~/state/session";

import { requireApprovalForDraft } from "../pullRequest/itemHandoff";
import { writeHandoffToComposer } from "../pullRequest/usePullRequestActions";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";

type IssueHandoffKind = "ask" | "send";

function ActionLabel({ label, description }: { label: string; description: string }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span>{label}</span>
      <span className="text-xs text-muted-foreground">{description}</span>
    </span>
  );
}

/** Ask and Send to agent for one issue, each opening a draft thread in the issue's project. */
export function IssueHandoffMenu({
  environmentId,
  projectId,
  issue,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  issue: HandoffIssue;
}) {
  const gt = useGT();
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const newThread = useNewThreadHandler();
  const [pending, setPending] = useState<IssueHandoffKind | null>(null);
  if (!canOperate) return null;

  // Nothing is sent: the user reads the draft over and sends it.
  const start = async (kind: IssueHandoffKind) => {
    if (pending !== null) return;
    setPending(kind);
    const opened = await newThread(scopeProjectRef(environmentId, projectId)).then(
      (session) => session,
      () => null,
    );
    setPending(null);
    if (opened === null) {
      toastManager.add({
        type: "error",
        title: m(msg("Could not open a thread")),
        description: m(msg("Try again from the project, or open a thread first.")),
      });
      return;
    }
    if (kind === "send") {
      writeHandoffToComposer(opened.draftId, { prompt: sendIssueToAgentPrompt(issue) });
      toastManager.add({
        type: "success",
        title: m(msg("Issue ready in a new thread")),
        description: m(msg("The task is in the composer. Read it over, then send.")),
      });
      return;
    }
    writeHandoffToComposer(opened.draftId, {
      prompt: "",
      reviewComments: [{ id: `issue-context:${issue.url}`, ...askAboutIssueContext(issue) }],
    });
    // The issue's text is untrusted, so a question asks before it changes anything.
    requireApprovalForDraft(opened.draftId);
    toastManager.add({
      type: "success",
      title: m(msg("Asked in a thread")),
      description: m(msg("The issue is in the composer. Type your question, then send.")),
    });
  };

  return (
    <Menu>
      <MenuTrigger
        disabled={pending !== null}
        render={<Button size="icon-xs" variant="ghost" aria-label={gt("Hand to an agent")} />}
      >
        <BotIcon aria-hidden className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end" side="bottom">
        <MenuItem onClick={() => void start("send")}>
          <BotIcon className="mt-1 size-3.5 shrink-0 self-start" />
          <ActionLabel
            label={gt("Send to agent")}
            description={gt("A new thread with the task in its composer, ready for you to send.")}
          />
        </MenuItem>
        <MenuItem onClick={() => void start("ask")}>
          <MessageCircleQuestionIcon className="mt-1 size-3.5 shrink-0 self-start" />
          <ActionLabel
            label={gt("Ask about this issue")}
            description={gt(
              "A new thread that knows which issue you mean. It asks before changing anything.",
            )}
          />
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
