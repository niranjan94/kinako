import { useAtomValue } from "@effect/atom-react";
import {
  type ContextWindowSegmentKind,
  type ContextWindowSnapshot,
  deriveContextWindowBreakdown,
  deriveLatestContextWindowSnapshot,
  formatContextWindowPercentage as formatPercentage,
  formatContextWindowTokens,
  latestProviderTurnTokenUsage,
} from "@t3tools/client-runtime/context-window";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { withUniwind } from "uniwind";

import { AppSheet } from "../../components/AppSheet";
import { AppText as Text } from "../../components/AppText";
import { useAndroidControlSizing } from "../../components/useAndroidControlSizing";
import { cn } from "../../lib/cn";
import { mobilePreferencesAtom } from "../../state/preferences";
import { useThreadProjection, useThreadVisibleTurnItems } from "../../state/use-thread-detail";

const ThemedSvg = withUniwind(Svg);

const RING_RADIUS = 9.75;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const USED_SEGMENT_CLASS_NAMES = [
  "bg-update-foreground",
  "bg-warning-foreground",
  "bg-primary",
  "bg-md-link",
  "bg-update-foreground/55",
  "bg-warning-foreground/55",
  "bg-primary/55",
  "bg-md-link/55",
];

function segmentClassName(kind: ContextWindowSegmentKind, usedIndex: number): string {
  if (kind === "free") return "bg-subtle-strong";
  if (kind === "buffer") return "bg-icon-subtle";
  return USED_SEGMENT_CLASS_NAMES[usedIndex % USED_SEGMENT_CLASS_NAMES.length]!;
}

function useThreadContextWindow(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ContextWindowSnapshot | null {
  const target = { environmentId, threadId };
  const thread = useThreadProjection(target);
  const visibleTurnItems = useThreadVisibleTurnItems(target);
  const projection = thread?.projection ?? null;
  return useMemo(() => {
    if (projection === null) return null;
    return deriveLatestContextWindowSnapshot(
      visibleTurnItems,
      latestProviderTurnTokenUsage(projection.providerTurns),
      projection.providerThreads.find(
        (providerThread) => providerThread.id === projection.thread.activeProviderThreadId,
      ),
    );
  }, [projection, visibleTurnItems]);
}

function ContextWindowDetails(props: { readonly usage: ContextWindowSnapshot }) {
  const { usage } = props;
  const breakdown = deriveContextWindowBreakdown(usage);
  const windowTokens = breakdown?.segments.reduce((sum, segment) => sum + segment.tokens, 0) ?? 0;
  const share = (tokens: number) => (windowTokens > 0 ? (tokens / windowTokens) * 100 : 0);
  let usedIndex = 0;
  const rows =
    breakdown?.segments.map((segment) => ({
      ...segment,
      className: segmentClassName(segment.kind, segment.kind === "used" ? usedIndex++ : 0),
    })) ?? [];

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-4 px-5 pb-8 pt-4"
    >
      <View className="flex-row items-baseline justify-between">
        <Text className="text-2xl font-t3-bold text-foreground">
          {formatContextWindowTokens(usage.usedTokens)}
          {usage.maxTokens != null ? (
            <Text className="text-base text-foreground-muted">
              {` / ${formatContextWindowTokens(usage.maxTokens)}`}
            </Text>
          ) : null}
        </Text>
        {usage.usedPercentage !== null ? (
          <Text className="text-base text-foreground-muted">
            {formatPercentage(usage.usedPercentage)} used
          </Text>
        ) : null}
      </View>
      {rows.length > 0 ? (
        <View className="h-2 flex-row gap-px overflow-hidden rounded-full bg-subtle">
          {rows.map((row, index) => (
            <View
              key={index}
              className={cn("h-full", row.className)}
              style={{ width: `${share(row.tokens)}%` }}
            />
          ))}
        </View>
      ) : null}
      {rows.length > 0 || (breakdown?.deferred.length ?? 0) > 0 ? (
        <View className="gap-2">
          {rows.map((row, index) => (
            <View key={`segment-${index}`} className="flex-row items-center gap-3">
              <View className={cn("size-2.5 rounded-xs", row.className)} />
              <Text className="flex-1 text-sm text-foreground" numberOfLines={1}>
                {row.label}
              </Text>
              <Text className="text-sm tabular-nums text-foreground-muted">
                {formatContextWindowTokens(row.tokens)}
              </Text>
              <Text className="w-12 text-right text-sm tabular-nums text-foreground-muted">
                {formatPercentage(share(row.tokens))}
              </Text>
            </View>
          ))}
          {breakdown?.deferred.map((row, index) => (
            <View key={`deferred-${index}`} className="flex-row items-center gap-3 opacity-70">
              <View className="size-2.5" />
              <Text className="flex-1 text-sm text-foreground" numberOfLines={1}>
                {row.label}
              </Text>
              <Text className="text-sm tabular-nums text-foreground-muted">
                {formatContextWindowTokens(row.tokens)}
              </Text>
              <View className="w-12" />
            </View>
          ))}
        </View>
      ) : null}
      {usage.totalProcessedTokens != null && usage.totalProcessedTokens > 0 ? (
        <View className="flex-row justify-between">
          <Text className="text-sm text-foreground-muted">Total processed</Text>
          <Text className="text-sm tabular-nums text-foreground-muted">
            {formatContextWindowTokens(usage.totalProcessedTokens)}
          </Text>
        </View>
      ) : null}
      {usage.compactsAutomatically ? (
        <Text className="text-sm text-foreground-muted">
          {typeof usage.autoCompactThreshold === "number" && usage.autoCompactThreshold > 0
            ? `Compacts automatically at ${usage.autoCompactThreshold.toLocaleString("en-US")} tokens.`
            : "Context compacts automatically when needed."}
        </Text>
      ) : null}
    </ScrollView>
  );
}

interface ComposerContextWindowMeterProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

/** Context window ring for the composer toolbar; tapping it opens the breakdown. */
export function ComposerContextWindowMeter(props: ComposerContextWindowMeterProps) {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const enabled =
    AsyncResult.isSuccess(preferences) && preferences.value.contextWindowIndicatorEnabled !== false;
  // Gate before subscribing, so a disabled meter does not re-render on every streamed update.
  return enabled ? <ContextWindowRing {...props} /> : null;
}

function ContextWindowRing(props: ComposerContextWindowMeterProps) {
  const usage = useThreadContextWindow(props.environmentId, props.threadId);
  const { scale } = useAndroidControlSizing();
  const [open, setOpen] = useState(false);

  if (usage === null) return null;

  const percentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const size = Math.round(20 * scale);
  const label =
    usage.usedPercentage !== null
      ? `Context window ${formatPercentage(usage.usedPercentage)} used`
      : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`;

  return (
    <>
      <Pressable
        accessibilityLabel={label}
        accessibilityRole="button"
        className="size-[44px] shrink-0 items-center justify-center rounded-full active:opacity-70"
        onPress={() => setOpen(true)}
      >
        <ThemedSvg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          colorClassName={percentage > 90 ? "accent-danger-foreground" : "accent-icon-muted"}
          style={{ transform: [{ rotate: "-90deg" }] }}
          accessible={false}
        >
          <Circle
            cx={12}
            cy={12}
            r={RING_RADIUS}
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.24}
            strokeWidth={3}
          />
          <Circle
            cx={12}
            cy={12}
            r={RING_RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth={3}
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={RING_CIRCUMFERENCE * (1 - percentage / 100)}
          />
        </ThemedSvg>
      </Pressable>
      {open ? (
        <AppSheet title="Context Window" onClose={() => setOpen(false)}>
          <ContextWindowDetails usage={usage} />
        </AppSheet>
      ) : null}
    </>
  );
}
