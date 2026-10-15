import type {
  EnvironmentId,
  MessageId,
  OrchestrationV2ConversationSummaryDirection,
  ProviderThreadId,
  ScopedThreadRef,
  ServerProviderSkill,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { ChevronDownIcon, ListCollapseIcon, RotateCcwIcon } from "lucide-react";
import { useState } from "react";

import { useRunHistory } from "../../state/queries";
import ChatMarkdown from "../ChatMarkdown";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Label } from "../ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ConversationSummaryItem } from "./MessagesTimeline.logic";

/** What the timeline needs to offer and show conversation summaries. */
export interface ConversationSummaryTimelineControls {
  readonly onSummarize: (
    messageId: MessageId,
    direction: OrchestrationV2ConversationSummaryDirection,
  ) => void;
  readonly onRestore: (turnItemId: TurnItemId) => void;
  /** Messages with an earlier turn, which "Summarize up to here" can cover. */
  readonly upToHereMessageIds: ReadonlySet<MessageId>;
  readonly supportsConversationRollback: boolean;
  readonly activeProviderThreadId: ProviderThreadId | null;
}

export const SUMMARY_DIRECTION_TITLES: Record<OrchestrationV2ConversationSummaryDirection, string> =
  {
    from_here: "Summarize from here",
    up_to_here: "Summarize up to here",
  };

function fromHereUnavailableReason(input: {
  readonly controls: ConversationSummaryTimelineControls;
  readonly canRewind: boolean;
}): string | null {
  if (!input.controls.supportsConversationRollback) {
    return "This provider cannot rewind its conversation.";
  }
  return input.canRewind ? null : "There is no checkpoint before this message.";
}

export function SummarizeMessageMenu(props: {
  readonly messageId: MessageId;
  readonly controls: ConversationSummaryTimelineControls;
  /** True when "Edit from here" is available, which "from here" also needs. */
  readonly canRewind: boolean;
  readonly disabled: boolean;
}) {
  const fromHereReason = fromHereUnavailableReason(props);
  const upToHereReason = props.controls.upToHereMessageIds.has(props.messageId)
    ? null
    : "There is nothing before this message to summarize.";
  const options: ReadonlyArray<{
    readonly direction: OrchestrationV2ConversationSummaryDirection;
    readonly reason: string | null;
  }> = [
    { direction: "from_here", reason: fromHereReason },
    { direction: "up_to_here", reason: upToHereReason },
  ];
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={props.disabled}
                  aria-label="Summarize conversation"
                />
              }
            />
          }
        >
          <ListCollapseIcon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup side="top">Summarize conversation</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end">
        {options.map((option) => (
          <MenuItem
            key={option.direction}
            disabled={option.reason !== null}
            {...(option.reason === null ? {} : { "aria-description": option.reason })}
            onClick={() => props.controls.onSummarize(props.messageId, option.direction)}
          >
            <span className="flex min-w-0 flex-col">
              <span>{SUMMARY_DIRECTION_TITLES[option.direction]}</span>
              {option.reason === null ? null : (
                <span className="text-muted-foreground text-xs">{option.reason}</span>
              )}
            </span>
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

function SummarizedTurns(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly runIds: ReadonlyArray<ConversationSummaryItem["range"]["coveredRunIds"][number]>;
  readonly markdownCwd: string | undefined;
  readonly threadRef: ScopedThreadRef | null;
  readonly skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
}) {
  const history = useRunHistory({
    environmentId: props.environmentId,
    threadId: props.threadId,
    runIds: props.runIds,
  });
  if (history.data == null) {
    return (
      <p className="text-muted-foreground text-xs">
        {history.error ?? "Loading summarized turns…"}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {history.data.messages.map((message) => (
        <div key={message.itemId} className="flex flex-col gap-1">
          <span className="font-medium text-muted-foreground text-xs">
            {message.kind === "user_message"
              ? "You"
              : message.kind === "assistant_message"
                ? "Agent"
                : `Agent · ${message.kind.replaceAll("_", " ")}`}
          </span>
          <div className="text-muted-foreground text-xs leading-relaxed">
            <ChatMarkdown
              text={message.text}
              cwd={props.markdownCwd}
              threadRef={props.threadRef ?? undefined}
              skills={props.skills}
              lineBreaks
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/** The marker where a summary replaced part of the provider's context. */
export function ConversationSummaryRow(props: {
  readonly item: ConversationSummaryItem;
  readonly label: string;
  readonly controls: ConversationSummaryTimelineControls | null;
  readonly environmentId: EnvironmentId;
  readonly markdownCwd: string | undefined;
  readonly threadRef: ScopedThreadRef | null;
  readonly skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  readonly disabled: boolean;
}) {
  const { item } = props;
  const [turnsOpen, setTurnsOpen] = useState(false);
  const restorable =
    props.controls !== null &&
    item.range.direction === "up_to_here" &&
    item.range.restoredAt === undefined &&
    item.range.summaryProviderThreadId === props.controls.activeProviderThreadId;
  const turnCount = item.range.coveredRunIds.length;
  return (
    <div className="mx-auto flex w-full max-w-(--chat-content-max-width) flex-col gap-1 py-1">
      <div
        role="separator"
        aria-label={props.label}
        className="flex items-center gap-3 text-muted-foreground text-xs"
      >
        <span className="h-px flex-1 bg-border/70" />
        <span className="flex shrink-0 items-center gap-1.5">
          <ListCollapseIcon aria-hidden="true" className="size-3" />
          {props.label}
        </span>
        <span className="h-px flex-1 bg-border/70" />
      </div>
      <div className="flex flex-wrap items-center justify-center gap-1">
        <Collapsible>
          <CollapsibleTrigger render={<Button type="button" size="micro" variant="ghost-muted" />}>
            Summary
            <ChevronDownIcon aria-hidden="true" />
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="mt-1 rounded-lg border border-border/60 px-3 py-2 text-muted-foreground text-xs leading-relaxed">
              {item.range.instructions === undefined ? null : (
                <p className="mb-2 italic">Focus: {item.range.instructions}</p>
              )}
              <ChatMarkdown
                text={item.summary ?? ""}
                cwd={props.markdownCwd}
                threadRef={props.threadRef ?? undefined}
                skills={props.skills}
                lineBreaks
              />
            </div>
          </CollapsiblePanel>
        </Collapsible>
        {item.range.direction === "from_here" && props.threadRef !== null ? (
          <Collapsible open={turnsOpen} onOpenChange={setTurnsOpen}>
            <CollapsibleTrigger
              render={<Button type="button" size="micro" variant="ghost-muted" />}
            >
              {turnCount === 1 ? "1 summarized turn" : `${turnCount} summarized turns`}
              <ChevronDownIcon aria-hidden="true" />
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <div className="mt-1 rounded-lg border border-border/60 px-3 py-2">
                {turnsOpen ? (
                  <SummarizedTurns
                    environmentId={props.environmentId}
                    threadId={props.threadRef.threadId}
                    runIds={item.range.coveredRunIds}
                    markdownCwd={props.markdownCwd}
                    threadRef={props.threadRef}
                    skills={props.skills}
                  />
                ) : null}
              </div>
            </CollapsiblePanel>
          </Collapsible>
        ) : null}
        {restorable ? (
          <Button
            type="button"
            size="micro"
            variant="ghost-muted"
            disabled={props.disabled}
            onClick={() => props.controls?.onRestore(item.id)}
          >
            <RotateCcwIcon aria-hidden="true" />
            Restore full context
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Confirms a summary and collects what it should focus on. */
export function SummarizeConversationDialog(props: {
  readonly direction: OrchestrationV2ConversationSummaryDirection | null;
  readonly onCancel: () => void;
  readonly onConfirm: (instructions: string) => void;
}) {
  const [instructions, setInstructions] = useState("");
  const direction = props.direction ?? "from_here";
  return (
    <AlertDialog
      open={props.direction !== null}
      onOpenChange={(open) => {
        if (!open) {
          setInstructions("");
          props.onCancel();
        }
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{SUMMARY_DIRECTION_TITLES[direction]}?</AlertDialogTitle>
          <AlertDialogDescription>
            {direction === "from_here"
              ? "This message and everything after it are replaced by a summary in the agent's context. Your prompt and attachments return to the composer. Files are not changed."
              : "Everything before this message is replaced by a summary in the agent's context. This message and everything after it stay as they are. Files are not changed, and you can restore the full context later."}
          </AlertDialogDescription>
          <Label htmlFor="summarize-conversation-instructions" className="mt-2">
            Focus (optional)
          </Label>
          <Textarea
            id="summarize-conversation-instructions"
            value={instructions}
            placeholder="What the summary should keep, such as decisions about the database schema"
            onChange={(event) => setInstructions(event.target.value)}
          />
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button
            onClick={() => {
              const value = instructions;
              setInstructions("");
              props.onConfirm(value);
            }}
          >
            Summarize
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
