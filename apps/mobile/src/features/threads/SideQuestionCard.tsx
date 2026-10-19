import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { sideChatMessages } from "@t3tools/client-runtime/state/side-chats";
import { resolveLatestMergeBackRun } from "@t3tools/client-runtime/state/thread-workflows";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import Animated, { FadeInDown, FadeOut } from "react-native-reanimated";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import { useThreadProjection, useThreadVisibleTurnItems } from "../../state/use-thread-detail";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { latestSideChatAtom, useSideQuestionActions } from "./useSideQuestion";

/** The parent thread's open side question, attached above the composer. */
export function SideQuestionCard(props: { readonly parentRef: ScopedThreadRef }) {
  const latest = useAtomValue(latestSideChatAtom(scopedThreadKey(props.parentRef)));
  if (latest === null || latest.settledOverride === "settled") return null;
  return <OpenSideQuestion key={latest.id} parentRef={props.parentRef} shell={latest} />;
}

function CardAction(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      hitSlop={6}
      className="min-h-8 justify-center active:opacity-70 disabled:opacity-40"
    >
      <Text className="font-t3-medium text-xs text-primary">{props.label}</Text>
    </Pressable>
  );
}

function OpenSideQuestion({
  parentRef,
  shell,
}: {
  readonly parentRef: ScopedThreadRef;
  readonly shell: EnvironmentThreadShell;
}) {
  const sideRef = scopeThreadRef(parentRef.environmentId, shell.id);
  const side = useThreadProjection(sideRef)?.projection ?? null;
  const messages = sideChatMessages(useThreadVisibleTurnItems(sideRef), shell.id);
  const actions = useSideQuestionActions();
  const markdownStyles = useMarkdownPreviewStyles();
  const openLink = useOpenPullRequest();
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
    <Animated.View
      className="shrink-0 px-4 pb-3"
      entering={FadeInDown.duration(180)}
      exiting={FadeOut.duration(120)}
    >
      <View className="gap-1.5 rounded-[20px] border-continuous bg-card px-4 pt-3 pb-1.5">
        <View className="flex-row items-center gap-2">
          <SymbolView
            name="questionmark.bubble"
            size={14}
            tintColorClassName="accent-icon-muted"
            type="monochrome"
          />
          <Text className="shrink-0 font-t3-medium text-sm text-foreground">Side question</Text>
          <Text
            accessibilityRole={error ? "alert" : undefined}
            accessibilityLiveRegion="polite"
            className={cn(
              "min-w-0 flex-1 text-xs",
              error ? "text-danger-foreground" : "text-foreground-muted",
            )}
            numberOfLines={1}
          >
            {status}
          </Text>
          {running ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Dismiss side question"
              disabled={busy}
              hitSlop={10}
              onPress={() => perform(() => actions.dismiss(sideRef))}
              className="p-1 active:opacity-60 disabled:opacity-40"
            >
              <SymbolView
                name="xmark"
                size={14}
                tintColorClassName="accent-icon-muted"
                type="monochrome"
              />
            </Pressable>
          )}
        </View>
        {messages.length > 0 ? (
          <ScrollView
            className="max-h-[220px] grow-0"
            contentContainerClassName="gap-2 pb-1"
            keyboardShouldPersistTaps="handled"
            nestedScrollEnabled
          >
            {messages.map((message) =>
              message.type === "user_message" ? (
                <Text key={message.id} selectable className="text-xs text-foreground-muted">
                  {replaceComposerContextReferences(message.text, () => "").trim()}
                </Text>
              ) : (
                <SelectableMarkdownText
                  key={message.id}
                  markdown={message.text}
                  textStyle={markdownStyles.nativeTextStyle}
                  onLinkPress={(href) => void openLink(href)}
                />
              ),
            )}
          </ScrollView>
        ) : null}
        <View className="flex-row flex-wrap items-center gap-x-4">
          {running ? (
            <CardAction
              label="Stop"
              disabled={busy}
              onPress={() => perform(() => actions.stop(sideRef))}
            />
          ) : (
            <CardAction
              label="Add to conversation"
              disabled={busy || !canJoin}
              onPress={() => side && perform(() => actions.join(parentRef, side))}
            />
          )}
          <CardAction
            label="Open as thread"
            disabled={busy}
            onPress={() => perform(() => actions.promote(sideRef))}
          />
        </View>
      </View>
    </Animated.View>
  );
}
