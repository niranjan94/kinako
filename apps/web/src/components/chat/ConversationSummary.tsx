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
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { useState } from "react";

import { m, type MessageResolver } from "../../i18n/messages";
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
  /** Messages with a ready checkpoint before their turn, which "Summarize from here" rewinds to. */
  readonly fromHereMessageIds: ReadonlySet<MessageId>;
  readonly supportsConversationRollback: boolean;
  readonly activeProviderThreadId: ProviderThreadId | null;
}

const SUMMARY_DIRECTION_TITLES: Record<
  OrchestrationV2ConversationSummaryDirection,
  { readonly title: string; readonly confirmTitle: string }
> = {
  from_here: {
    title: msg("Summarize from here"),
    confirmTitle: msg("Summarize from here?"),
  },
  up_to_here: {
    title: msg("Summarize up to here"),
    confirmTitle: msg("Summarize up to here?"),
  },
};

function fromHereUnavailableReason(input: {
  readonly controls: ConversationSummaryTimelineControls;
  readonly messageId: MessageId;
  readonly resolve?: MessageResolver;
}): string | null {
  const resolve = input.resolve ?? m;
  if (!input.controls.supportsConversationRollback) {
    return resolve(msg("This provider cannot rewind its conversation."));
  }
  return input.controls.fromHereMessageIds.has(input.messageId)
    ? null
    : resolve(msg("There is no checkpoint before this message."));
}

export function SummarizeMessageMenu(props: {
  readonly messageId: MessageId;
  readonly controls: ConversationSummaryTimelineControls;
  readonly disabled: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const fromHereReason = fromHereUnavailableReason({ ...props, resolve: m });
  const upToHereReason = props.controls.upToHereMessageIds.has(props.messageId)
    ? null
    : gt("There is nothing before this message to summarize.");
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
                  aria-label={gt("Summarize conversation")}
                />
              }
            />
          }
        >
          <ListCollapseIcon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup side="top">{gt("Summarize conversation")}</TooltipPopup>
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
              <span>{m(SUMMARY_DIRECTION_TITLES[option.direction].title)}</span>
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
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}) {
  const gt = useGT();
  const history = useRunHistory({
    environmentId: props.environmentId,
    threadId: props.threadId,
    runIds: props.runIds,
  });
  if (history.data == null) {
    return (
      <p className="text-muted-foreground text-xs">
        {history.error ?? gt("Loading summarized turns…")}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {history.data.messages.map((message) => (
        <div key={message.itemId} className="flex flex-col gap-1">
          <span className="font-medium text-muted-foreground text-xs">
            {message.kind === "user_message"
              ? gt("You", { $context: "label for the user's own message" })
              : message.kind === "assistant_message"
                ? gt("Agent", { $context: "label for the agent's message" })
                : gt("Agent · {kind}", { kind: message.kind.replaceAll("_", " ") })}
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
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly disabled: boolean;
}) {
  const gt = useGT();
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
            <T>Summary</T>
            <ChevronDownIcon aria-hidden="true" />
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="mt-1 rounded-lg border border-border/60 px-3 py-2 text-muted-foreground text-xs leading-relaxed">
              {item.range.instructions === undefined ? null : (
                <p className="mb-2 italic">
                  <T>
                    Focus: <Var>{item.range.instructions}</Var>
                  </T>
                </p>
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
              {gt(
                "{count, plural, one {{count} summarized turn} other {{count} summarized turns}}",
                {
                  count: turnCount,
                },
              )}
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
            <T>Restore full context</T>
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
  const gt = useGT();
  const m = useMessages();
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
          <AlertDialogTitle>{m(SUMMARY_DIRECTION_TITLES[direction].confirmTitle)}</AlertDialogTitle>
          <AlertDialogDescription>
            {direction === "from_here"
              ? gt(
                  "This message and everything after it are replaced by a summary in the agent's context. Your prompt and attachments return to the composer. Files are not changed.",
                )
              : gt(
                  "Everything before this message is replaced by a summary in the agent's context. This message and everything after it stay as they are. Files are not changed, and you can restore the full context later.",
                )}
          </AlertDialogDescription>
          <Label htmlFor="summarize-conversation-instructions" className="mt-2">
            <T>Focus (optional)</T>
          </Label>
          <Textarea
            id="summarize-conversation-instructions"
            value={instructions}
            placeholder={gt(
              "What the summary should keep, such as decisions about the database schema",
            )}
            onChange={(event) => setInstructions(event.target.value)}
          />
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>
            <T>Cancel</T>
          </AlertDialogClose>
          <Button
            onClick={() => {
              const value = instructions;
              setInstructions("");
              props.onConfirm(value);
            }}
          >
            <T>Summarize</T>
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
