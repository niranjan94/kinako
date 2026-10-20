import {
  TURN_RECAP_OUTCOME_LABELS,
  type TurnRecap,
  type TurnRecapOutcome,
} from "@t3tools/client-runtime/state/turn-recap";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { PullRequestDiffStats } from "../pull-requests/PullRequestPresentation";

const OUTCOME_TONE: Record<TurnRecapOutcome, string> = {
  completed: "text-adaptive-emerald-600-400",
  input: "text-warning-foreground",
  approval: "text-warning-foreground",
  failed: "text-danger-foreground",
  limited: "text-warning-foreground",
};

export function TurnRecapCard(props: { readonly recap: TurnRecap }) {
  const { recap } = props;
  const { changes } = recap;
  const finalMessage = recap.finalMessage?.elided ? recap.finalMessage.text : null;
  if (recap.outcome === "completed" && changes === null && finalMessage === null) return null;
  return (
    <View
      accessibilityLabel="Turn recap"
      className="mb-3 gap-1.5 rounded-[20px] border border-border bg-card-alt px-4 py-3"
    >
      <View className="flex-row flex-wrap items-center gap-x-3 gap-y-1">
        <Text
          className={cn(
            "font-t3-bold text-2xs uppercase tracking-[1.1px]",
            OUTCOME_TONE[recap.outcome],
          )}
        >
          {TURN_RECAP_OUTCOME_LABELS[recap.outcome]}
        </Text>
        {changes ? (
          <View className="flex-row items-center gap-2">
            <Text className="font-t3-medium text-xs text-foreground-secondary">
              {changes.fileCount} changed file{changes.fileCount === 1 ? "" : "s"}
            </Text>
            <PullRequestDiffStats
              additions={changes.additions}
              deletions={changes.deletions}
              compact
            />
          </View>
        ) : null}
      </View>
      {recap.request ? (
        <Text className="font-sans text-sm leading-normal text-foreground" numberOfLines={3}>
          {recap.request}
        </Text>
      ) : null}
      {finalMessage ? (
        <Text className="font-sans text-sm leading-normal text-foreground-muted" numberOfLines={3}>
          {finalMessage}
        </Text>
      ) : null}
    </View>
  );
}
