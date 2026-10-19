import type { RunId, ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useThreadVisibleTurnItems } from "../../state/use-thread-detail";

export function ComposerTasks(props: { readonly target: ScopedThreadRef; readonly runId: RunId }) {
  const items = useThreadVisibleTurnItems(props.target);
  const [expanded, setExpanded] = useState(false);
  const plan = items.findLast(
    ({ item }) => item.type === "todo_list" && item.runId === props.runId,
  )?.item;
  if (plan?.type !== "todo_list" || plan.steps.length === 0) return null;

  const completed = plan.steps.filter((step) => step.status === "completed").length;
  const current =
    plan.steps.find((step) => step.status === "running") ??
    plan.steps.find((step) => step.status === "pending") ??
    plan.steps.at(-1)!;
  const occurrences = new Map<string, number>();
  const keyedSteps = plan.steps.map((step) => {
    const occurrence = occurrences.get(step.text) ?? 0;
    occurrences.set(step.text, occurrence + 1);
    return { key: `${step.text}:${occurrence}`, step };
  });

  return (
    <View className="mx-4 mb-2 overflow-hidden rounded-2xl border border-border bg-card">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Tasks: ${completed} of ${plan.steps.length} complete. Current task: ${current.text}`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        className="min-h-11 flex-row items-center gap-2 px-3 py-2 active:opacity-70"
      >
        <Text className="text-xs text-foreground-muted">Tasks</Text>
        <Text className="flex-1 text-sm text-foreground" numberOfLines={1}>
          {current.text}
        </Text>
        <Text className="text-xs tabular-nums text-foreground-muted">
          {completed}/{plan.steps.length}
        </Text>
        <SymbolView
          name={expanded ? "chevron.up" : "chevron.down"}
          size={14}
          tintColorClassName="accent-icon-muted"
        />
      </Pressable>
      {expanded ? (
        <ScrollView
          style={{ maxHeight: 200 }}
          contentContainerClassName="gap-3 px-3 pb-3"
          nestedScrollEnabled
        >
          {keyedSteps.map(({ key, step }) => (
            <View key={key} className="flex-row items-start gap-2">
              <SymbolView
                name={
                  step.status === "completed"
                    ? "checkmark.circle"
                    : step.status === "running"
                      ? "circle.inset.filled"
                      : "circle"
                }
                size={16}
                tintColorClassName={
                  step.status === "running" ? "accent-primary" : "accent-icon-muted"
                }
              />
              <Text
                accessibilityLabel={`${step.status === "running" ? "Running" : step.status === "completed" ? "Completed" : "Pending"}: ${step.text}`}
                className={
                  step.status === "running"
                    ? "flex-1 text-sm text-foreground"
                    : "flex-1 text-sm text-foreground-muted"
                }
              >
                {step.text}
              </Text>
            </View>
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}
