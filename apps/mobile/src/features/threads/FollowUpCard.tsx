import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation } from "@react-navigation/native";
import {
  followUpDisplay,
  followUpFailureMessage,
  type FollowUpItem,
} from "@t3tools/client-runtime/follow-up";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  FollowUpStartInput,
  OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View, type ColorValue } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

const FOLLOW_UP_SYMBOL: AppSymbolName = "plus";

export function FollowUpCard(props: {
  readonly environmentId: EnvironmentId;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly iconColor: ColorValue;
}) {
  const navigation = useNavigation();
  const { item, visibility } = props.projectedItem;
  if (item.type !== "follow_up") return null;
  const display = followUpDisplay(item, visibility);
  if (display.kind === "suggested") {
    return (
      <SuggestedFollowUp
        environmentId={props.environmentId}
        item={item}
        iconColor={props.iconColor}
      />
    );
  }
  if (display.kind === "dismissed") {
    return (
      <DismissedFollowUp
        environmentId={props.environmentId}
        item={item}
        iconColor={props.iconColor}
      />
    );
  }
  const startedThreadId = display.kind === "started" ? display.threadId : null;
  const row = (
    <View className="mb-3 min-h-9 flex-row items-center gap-2 px-1">
      <SymbolView
        name={display.kind === "started" ? "checkmark" : FOLLOW_UP_SYMBOL}
        size={13}
        tintColor={props.iconColor}
        type="monochrome"
      />
      <Text className="flex-1 font-sans text-sm text-foreground-muted" numberOfLines={2}>
        {item.label} ·{" "}
        {display.kind === "started"
          ? "Started in a new thread"
          : "Suggested in the original thread"}
      </Text>
    </View>
  );
  if (startedThreadId === null) return row;
  return (
    <Pressable
      accessibilityRole="button"
      className="active:opacity-60"
      onPress={() =>
        // Push, not navigate: navigate reuses this Thread route, so back would
        // skip the thread that suggested the follow-up.
        navigation.dispatch(
          StackActions.push("Thread", {
            environmentId: props.environmentId,
            threadId: startedThreadId,
          }),
        )
      }
    >
      {row}
    </Pressable>
  );
}

function useFollowUpAction(environmentId: EnvironmentId) {
  const canOperate = useAtomValue(serverEnvironment.startFollowUp.permissionAtom(environmentId));
  const start = useAtomCommand(serverEnvironment.startFollowUp, { label: "start follow-up" });
  const setDismissed = useAtomCommand(serverEnvironment.setFollowUpDismissed, {
    label: "update follow-up",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => ReturnType<typeof start> | ReturnType<typeof setDismissed>) => {
    setBusy(true);
    setError(null);
    const result = await action().finally(() => setBusy(false));
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setError(followUpFailureMessage(squashAtomCommandFailure(result)));
    }
  };
  return { start, setDismissed, disabled: busy || !canOperate, error, run };
}

function SuggestedFollowUp(props: {
  readonly environmentId: EnvironmentId;
  readonly item: FollowUpItem;
  readonly iconColor: ColorValue;
}) {
  const { item, environmentId } = props;
  const { start, setDismissed, disabled, error, run } = useFollowUpAction(environmentId);
  // Omitting the workspace follows the project's default for new threads.
  const startIn = (workspace?: NonNullable<FollowUpStartInput["workspace"]>) =>
    void run(() =>
      start({
        environmentId,
        input: {
          threadId: item.threadId,
          turnItemId: item.id,
          ...(workspace === undefined ? {} : { workspace }),
        },
      }),
    );

  return (
    <View className="mb-3 gap-3 rounded-[20px] border border-border bg-card-alt p-4">
      <View className="flex-row gap-2">
        <SymbolView
          name={FOLLOW_UP_SYMBOL}
          size={15}
          tintColor={props.iconColor}
          type="monochrome"
        />
        <View className="flex-1 gap-1">
          <Text className="font-t3-bold text-base text-foreground">{item.label}</Text>
          <Text className="font-sans text-sm leading-5 text-foreground-muted" numberOfLines={3}>
            {item.prompt}
          </Text>
        </View>
      </View>
      {error !== null ? (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className="font-sans text-sm text-danger-foreground"
        >
          {error}
        </Text>
      ) : null}
      <Button label="Start thread" tone="primary" disabled={disabled} onPress={() => startIn()} />
      <View className="flex-row items-center justify-between gap-2">
        <View className="flex-row items-center gap-3">
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled }}
            disabled={disabled}
            hitSlop={8}
            className="px-1 py-1 active:opacity-60 disabled:opacity-50"
            onPress={() => startIn("current")}
          >
            <Text className="font-sans text-xs text-foreground-muted">This checkout</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled }}
            disabled={disabled}
            hitSlop={8}
            className="px-1 py-1 active:opacity-60 disabled:opacity-50"
            onPress={() => startIn("worktree")}
          >
            <Text className="font-sans text-xs text-foreground-muted">New worktree</Text>
          </Pressable>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled }}
          disabled={disabled}
          hitSlop={8}
          className="px-1 py-1 active:opacity-60 disabled:opacity-50"
          onPress={() =>
            void run(() =>
              setDismissed({
                environmentId,
                input: { threadId: item.threadId, turnItemId: item.id, dismissed: true },
              }),
            )
          }
        >
          <Text className="font-sans text-xs text-foreground-muted">Dismiss</Text>
        </Pressable>
      </View>
    </View>
  );
}

function DismissedFollowUp(props: {
  readonly environmentId: EnvironmentId;
  readonly item: FollowUpItem;
  readonly iconColor: ColorValue;
}) {
  const { item, environmentId } = props;
  const { setDismissed, disabled, error, run } = useFollowUpAction(environmentId);
  return (
    <View className="mb-3 min-h-9 flex-row items-center gap-2 px-1">
      <SymbolView name="minus" size={13} tintColor={props.iconColor} type="monochrome" />
      <Text className="flex-1 font-sans text-sm text-foreground-muted" numberOfLines={2}>
        {item.label} · {error ?? "Dismissed"}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        disabled={disabled}
        hitSlop={8}
        className="px-1 py-1 active:opacity-60 disabled:opacity-50"
        onPress={() =>
          void run(() =>
            setDismissed({
              environmentId,
              input: { threadId: item.threadId, turnItemId: item.id, dismissed: false },
            }),
          )
        }
      >
        <Text className="font-sans text-xs text-foreground-muted">Restore</Text>
      </Pressable>
    </View>
  );
}
