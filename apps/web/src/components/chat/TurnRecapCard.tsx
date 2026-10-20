import { type RunId } from "@t3tools/contracts";
import {
  TURN_RECAP_OUTCOME_LABELS,
  type TurnRecap,
  type TurnRecapOutcome,
} from "@t3tools/client-runtime/state/turn-recap";
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  FileDiffIcon,
  GaugeIcon,
  MessageCircleQuestionIcon,
  ShieldAlertIcon,
} from "lucide-react";
import { memo } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";

const OUTCOME_PRESENTATION = {
  completed: { variant: "success", Icon: CheckCircle2Icon },
  input: { variant: "warning", Icon: MessageCircleQuestionIcon },
  approval: { variant: "warning", Icon: ShieldAlertIcon },
  failed: { variant: "error", Icon: CircleAlertIcon },
  limited: { variant: "warning", Icon: GaugeIcon },
} as const satisfies Record<TurnRecapOutcome, unknown>;

export const TurnRecapCard = memo(function TurnRecapCard(props: {
  recap: TurnRecap;
  /** The run's changed-files card already sits above, so the recap would repeat it. */
  changesShownAbove: boolean;
  onOpenTurnDiff: (runId: RunId) => void;
}) {
  const { recap, changesShownAbove, onOpenTurnDiff } = props;
  const { variant, Icon } = OUTCOME_PRESENTATION[recap.outcome];
  const { runId } = recap;
  const changes = changesShownAbove ? null : recap.changes;
  const finalMessage = recap.finalMessage?.elided ? recap.finalMessage.text : null;
  if (recap.outcome === "completed" && changes === null && finalMessage === null) return null;

  return (
    <div className="mb-3 px-1">
      <section
        aria-label="Turn recap"
        data-turn-recap={recap.outcome}
        className="flex flex-col gap-1.5 rounded-lg bg-secondary px-3 py-2.5 text-sm sm:text-xs dark:bg-input/20"
      >
        <div className="flex min-w-0 items-center gap-3">
          <Badge variant={variant}>
            <Icon />
            {TURN_RECAP_OUTCOME_LABELS[recap.outcome]}
          </Badge>
          {changes ? (
            <span className="flex min-w-0 items-center gap-2 font-medium text-foreground">
              <span className="truncate">
                {changes.fileCount} changed file{changes.fileCount === 1 ? "" : "s"}
              </span>
              {hasNonZeroStat(changes) ? (
                <DiffStatLabel
                  additions={changes.additions}
                  deletions={changes.deletions}
                  layout="inline"
                />
              ) : null}
            </span>
          ) : null}
          {changes && runId !== null ? (
            <span className="ml-auto shrink-0">
              <Button
                type="button"
                size="xs"
                variant="ghost-muted"
                aria-label="Open diff"
                onClick={() => onOpenTurnDiff(runId)}
              >
                <FileDiffIcon className="size-3" />
                <span className="max-sm:hidden">Open diff</span>
              </Button>
            </span>
          ) : null}
        </div>
        {recap.request ? (
          <p className="line-clamp-3 whitespace-pre-wrap wrap-break-word text-foreground">
            {recap.request}
          </p>
        ) : null}
        {finalMessage ? (
          <p className="line-clamp-3 wrap-break-word leading-relaxed text-muted-foreground">
            {finalMessage}
          </p>
        ) : null}
      </section>
    </div>
  );
});
