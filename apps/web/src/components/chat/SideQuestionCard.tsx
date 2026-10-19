import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import { sideChatMessages } from "@t3tools/client-runtime/state/side-chats";
import { resolveLatestMergeBackRun } from "@t3tools/client-runtime/state/thread-workflows";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { MessageCircleQuestionMarkIcon } from "lucide-react";
import { memo, useState } from "react";
import { stripInlineContextReferences } from "../../lib/composerContextReferences";
import { useThreadProjection, useThreadVisibleTurnItems } from "../../state/entities";
import { latestSideChatAtom } from "../../state/sideChats";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { ComposerBanner } from "./ComposerBanner";
import { useSideQuestionActions } from "./useSideQuestion";

export const SideQuestionCard = memo(function SideQuestionCard(props: {
  parentRef: ScopedThreadRef;
  workspaceRoot: string | undefined;
}) {
  const latest = useAtomValue(latestSideChatAtom(scopedThreadKey(props.parentRef)));
  if (latest === null || latest.settledOverride === "settled") return null;
  return <OpenSideQuestion key={latest.id} {...props} shell={latest} />;
});

function OpenSideQuestion({
  parentRef,
  workspaceRoot,
  shell,
}: {
  parentRef: ScopedThreadRef;
  workspaceRoot: string | undefined;
  shell: EnvironmentThreadShell;
}) {
  const sideRef = scopeThreadRef(parentRef.environmentId, shell.id);
  const side = useThreadProjection(sideRef)?.projection ?? null;
  const messages = sideChatMessages(useThreadVisibleTurnItems(sideRef), shell.id);
  const actions = useSideQuestionActions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = threadRuntimeIsActive(shell.runtime);
  const canJoin = !running && side !== null && resolveLatestMergeBackRun(side) !== null;

  const perform = (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void work()
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "The side question action failed."),
      )
      .finally(() => setBusy(false));
  };

  const status = running
    ? shell.hasPendingApprovals || shell.hasPendingUserInput
      ? "Needs your input. Open as thread to respond."
      : "Thinking…"
    : (error ?? shell.runtime?.lastError ?? "Use /btw to follow up");

  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root data-side-question="true">
        <ComposerBanner.Row>
          <ComposerBanner.Icon>
            <MessageCircleQuestionMarkIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content>
            <span className="shrink-0 font-medium text-foreground">Side question</span>
            <ComposerBanner.Separator />
            <span
              role={error ? "alert" : "status"}
              className={error ? "truncate text-destructive" : "truncate text-muted-foreground"}
            >
              {status}
            </span>
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            {running ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => perform(() => actions.stop(sideRef))}
              >
                Stop
              </Button>
            ) : (
              <Button
                size="xs"
                variant="ghost"
                disabled={busy || !canJoin}
                onClick={() => side && perform(() => actions.join(parentRef, side))}
              >
                Add to conversation
              </Button>
            )}
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => perform(() => actions.promote(sideRef))}
            >
              Open as thread
            </Button>
            {running ? null : (
              <ComposerBanner.Dismiss
                aria-label="Dismiss side question"
                disabled={busy}
                onClick={() => perform(() => actions.dismiss(sideRef))}
              />
            )}
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
        {messages.length > 0 ? (
          <ComposerBanner.Scroll>
            <ComposerBanner.Body className="space-y-2 pe-3 pb-2 text-sm">
              {messages.map((message) =>
                message.type === "user_message" ? (
                  <p key={message.id} className="text-xs text-muted-foreground wrap-anywhere">
                    {stripInlineContextReferences(message.text)}
                  </p>
                ) : (
                  <ChatMarkdown
                    key={message.id}
                    text={message.text}
                    cwd={workspaceRoot}
                    threadRef={sideRef}
                    pullRequestPanelRef={parentRef}
                    environmentId={parentRef.environmentId}
                    isStreaming={message.streaming}
                  />
                ),
              )}
            </ComposerBanner.Body>
          </ComposerBanner.Scroll>
        ) : null}
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}
