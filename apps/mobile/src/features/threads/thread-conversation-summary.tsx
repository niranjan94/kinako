import type {
  EnvironmentId,
  MessageId,
  OrchestrationV2CompactionRange,
  OrchestrationV2ConversationSummaryDirection,
  OrchestrationV2TurnItem,
  ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View, type ColorValue } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import { useRunHistory } from "../../state/queries";
import { ThreadContextDivider } from "./thread-context-divider";
import type { ConversationSummaryFeedControls } from "./use-conversation-summary";

type ConversationSummaryItem = Extract<OrchestrationV2TurnItem, { readonly type: "compaction" }> & {
  readonly range: OrchestrationV2CompactionRange;
};

export function conversationSummaryItem(
  item: OrchestrationV2TurnItem,
): ConversationSummaryItem | null {
  return item.type === "compaction" && item.range !== undefined
    ? { ...item, range: item.range }
    : null;
}

const DIRECTIONS: ReadonlyArray<{
  readonly id: OrchestrationV2ConversationSummaryDirection;
  readonly title: string;
}> = [
  { id: "from_here", title: "Summarize from here" },
  { id: "up_to_here", title: "Summarize up to here" },
];

/** Opens the summarize choices for a sent user message. */
export function UserMessageSummarizeButton(props: {
  readonly messageId: MessageId;
  readonly controls: ConversationSummaryFeedControls;
  readonly tintColor: ColorValue;
}) {
  const actions = DIRECTIONS.map((direction) => {
    const reason =
      direction.id === "from_here"
        ? props.controls.fromHereUnavailableReason(props.messageId)
        : props.controls.upToHereUnavailableReason(props.messageId);
    return {
      id: direction.id,
      title: direction.title,
      ...(reason === null ? {} : { subtitle: reason, attributes: { disabled: true } }),
    };
  });
  return (
    <Menu
      actions={actions}
      onPressAction={({ nativeEvent }) => {
        const direction = DIRECTIONS.find((candidate) => candidate.id === nativeEvent.event);
        if (direction !== undefined) props.controls.summarize(props.messageId, direction.id);
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Summarize conversation"
        disabled={props.controls.busy}
        hitSlop={8}
        className="size-7 items-center justify-center"
      >
        <SymbolView
          name="arrow.down.right.and.arrow.up.left"
          size={13}
          tintColor={props.tintColor}
        />
      </Pressable>
    </Menu>
  );
}

function SummarizedTurns(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly runIds: ConversationSummaryItem["range"]["coveredRunIds"];
}) {
  const history = useRunHistory(props);
  if (history.data === null) {
    return (
      <Text className="text-xs text-foreground-muted">
        {history.error ?? "Loading summarized turns…"}
      </Text>
    );
  }
  return (
    <View className="gap-3">
      {history.data.messages.map((message) => (
        <View key={message.itemId} className="gap-1">
          <Text className="font-t3-medium text-xs text-foreground-secondary">
            {message.kind === "user_message"
              ? "You"
              : message.kind === "assistant_message"
                ? "Agent"
                : `Agent · ${message.kind.replaceAll("_", " ")}`}
          </Text>
          <Text selectable className="text-xs text-foreground-muted">
            {message.text}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** The marker where a summary replaced part of the agent's context. */
export function ConversationSummaryDivider(props: {
  readonly item: ConversationSummaryItem;
  readonly label: string;
  readonly controls: ConversationSummaryFeedControls | null;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly iconColor: ColorValue;
}) {
  const { item } = props;
  const [open, setOpen] = useState<"summary" | "turns" | null>(null);
  const toggle = (panel: "summary" | "turns") => setOpen(open === panel ? null : panel);
  const restorable =
    props.controls !== null &&
    item.range.direction === "up_to_here" &&
    item.range.restoredAt === undefined &&
    item.range.summaryProviderThreadId === props.controls.activeProviderThreadId;
  const turnCount = item.range.coveredRunIds.length;
  return (
    <View>
      <ThreadContextDivider
        label={props.label}
        icon="arrow.down.right.and.arrow.up.left"
        iconColor={props.iconColor}
      >
        <Pressable accessibilityRole="button" hitSlop={8} onPress={() => toggle("summary")}>
          <Text className="font-t3-medium text-xs text-foreground-secondary">Summary</Text>
        </Pressable>
        {item.range.direction === "from_here" ? (
          <Pressable accessibilityRole="button" hitSlop={8} onPress={() => toggle("turns")}>
            <Text className="font-t3-medium text-xs text-foreground-secondary">
              {turnCount === 1 ? "1 turn" : `${turnCount} turns`}
            </Text>
          </Pressable>
        ) : null}
        {restorable ? (
          <Pressable
            accessibilityRole="button"
            disabled={props.controls?.busy}
            hitSlop={8}
            onPress={() => props.controls?.restore(item.id)}
          >
            <Text className="font-t3-medium text-xs text-foreground-secondary">
              Restore full context
            </Text>
          </Pressable>
        ) : null}
      </ThreadContextDivider>
      {open === null ? null : (
        <View className="mb-3 gap-2 rounded-xl border border-separator px-3 py-2">
          {open === "summary" ? (
            <>
              {item.range.instructions === undefined ? null : (
                <Text className="text-xs italic text-foreground-muted">
                  Focus: {item.range.instructions}
                </Text>
              )}
              <Text selectable className="text-xs text-foreground-muted">
                {item.summary ?? ""}
              </Text>
            </>
          ) : (
            <SummarizedTurns
              environmentId={props.environmentId}
              threadId={props.threadId}
              runIds={item.range.coveredRunIds}
            />
          )}
        </View>
      )}
    </View>
  );
}
