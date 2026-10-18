import { Button } from "../ui/button";
import {
  type ContextWindowBreakdown,
  type ContextWindowSnapshot,
  deriveContextWindowBreakdown,
  formatContextWindowPercentage,
  formatContextWindowTokens,
} from "@t3tools/client-runtime/context-window";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  contextWindowSegmentColor,
  formatContextWindowCompactionMessage,
  formatContextWindowCost,
} from "./ContextWindowMeter.logic";
import { Minimize2Icon } from "lucide-react";
import { composerFloatingLayerProps } from "./composerEventScope";

function formatPercentage(value: number | null): string | null {
  return value === null || !Number.isFinite(value) ? null : formatContextWindowPercentage(value);
}

function ContextWindowBreakdownView(props: { breakdown: ContextWindowBreakdown }) {
  const { segments, deferred } = props.breakdown;
  const windowTokens = segments.reduce((sum, segment) => sum + segment.tokens, 0);
  const share = (tokens: number) => (windowTokens > 0 ? (tokens / windowTokens) * 100 : 0);
  let usedIndex = 0;
  const rows = [];
  for (const segment of segments) {
    const color = contextWindowSegmentColor(
      segment.kind,
      segment.kind === "used" ? usedIndex++ : 0,
    );
    rows.push({ ...segment, color });
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        className="flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-muted/60"
        role="img"
        aria-label="Context window usage by category"
      >
        {rows.map((row, index) => (
          <div
            key={index}
            className="h-full"
            style={{ width: `${share(row.tokens)}%`, backgroundColor: row.color }}
          />
        ))}
      </div>
      <dl className="flex flex-col gap-0.5 text-2xs leading-4">
        {rows.map((row, index) => (
          <div key={`segment-${index}`} className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="size-2 shrink-0 rounded-xs"
              style={{ backgroundColor: row.color }}
            />
            <dt className="min-w-0 flex-1 truncate text-secondary-label">{row.label}</dt>
            <dd className="tabular-nums text-secondary-label">
              {formatContextWindowTokens(row.tokens)}
            </dd>
            <dd className="w-10 text-right font-medium tabular-nums text-secondary-label">
              {formatPercentage(share(row.tokens))}
            </dd>
          </div>
        ))}
        {deferred.map((row, index) => (
          <div key={`deferred-${index}`} className="flex items-center gap-2 opacity-70">
            <span aria-hidden="true" className="size-2 shrink-0" />
            <dt className="min-w-0 flex-1 truncate text-secondary-label">{row.label}</dt>
            <dd className="tabular-nums text-secondary-label">
              {formatContextWindowTokens(row.tokens)}
            </dd>
            <dd className="w-10" />
          </div>
        ))}
      </dl>
    </div>
  );
}

export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot;
  modelDisplayName?: string | null;
  onCompact?: (() => void) | undefined;
  compactDisabled?: boolean | undefined;
  compactDisabledReason?: string | null | undefined;
}) {
  const { usage, modelDisplayName, onCompact, compactDisabled, compactDisabledReason } = props;
  const usedPercentage = formatPercentage(usage.usedPercentage);
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - normalizedPercentage / 100);
  const totalProcessedTokens = usage.totalProcessedTokens ?? null;
  const showTotalProcessed = totalProcessedTokens !== null && totalProcessedTokens > 0;
  const breakdown = deriveContextWindowBreakdown(usage);
  const isOverloaded = normalizedPercentage > 90;
  const usageColor = isOverloaded
    ? "var(--color-error)"
    : "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={onCompact ? 150 : 0}
        render={
          <Button
            size="icon-sm"
            variant="ghost-muted"
            className="size-7"
            aria-label={
              usage.maxTokens !== null && usedPercentage
                ? `Context window ${usedPercentage} used`
                : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`
            }
          >
            <span className="relative flex size-5 items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="-rotate-90 absolute inset-0 size-full transform-gpu mx-0!"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  className="stroke-muted-foreground/24"
                  strokeWidth="3"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke={usageColor}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className="transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none"
                />
              </svg>
            </span>
          </Button>
        }
      />
      <PopoverPopup
        {...composerFloatingLayerProps}
        tooltipStyle
        side="top"
        align="end"
        padding="none"
        width={breakdown ? "md" : "sm"}
        className="text-left whitespace-normal"
      >
        <div className="flex flex-col gap-2 p-(--floating-content-inset)">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-muted-foreground text-xs">Context Window</div>
            {usage.maxTokens !== null && usedPercentage ? (
              <div className="text-secondary-label text-2xs tabular-nums">
                <span>{usedPercentage}</span>
                <span className="mx-1">·</span>
                <span>
                  {formatContextWindowTokens(usage.usedTokens)}/
                  {formatContextWindowTokens(usage.maxTokens ?? null)}
                </span>
              </div>
            ) : (
              <div className="text-secondary-label text-2xs tabular-nums">
                {formatContextWindowTokens(usage.usedTokens)}
              </div>
            )}
          </div>
          {breakdown ? (
            <ContextWindowBreakdownView breakdown={breakdown} />
          ) : usage.maxTokens !== null ? (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(normalizedPercentage)}
              aria-label="Context window usage"
            >
              <div
                className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
                style={{ width: `${normalizedPercentage}%`, backgroundColor: usageColor }}
              />
            </div>
          ) : null}
          {showTotalProcessed ? (
            <div className="flex items-center justify-between gap-3 text-2xs leading-4">
              <span className="text-secondary-label">Total processed</span>
              <span className="font-medium tabular-nums text-secondary-label">
                {formatContextWindowTokens(totalProcessedTokens)}
              </span>
            </div>
          ) : null}
          {usage.cost != null ? (
            <div className="flex items-center justify-between gap-3 text-2xs leading-4">
              <span className="text-secondary-label">Cost</span>
              <span className="font-medium tabular-nums text-secondary-label">
                {formatContextWindowCost(usage.cost)}
              </span>
            </div>
          ) : null}
          {usage.compactsAutomatically ? (
            <div className="mt-1 text-pretty text-secondary-label text-2xs font-medium">
              {formatContextWindowCompactionMessage(modelDisplayName, usage.autoCompactThreshold)}
            </div>
          ) : null}
          {onCompact ? (
            <>
              <Button
                size="xs"
                variant="outline"
                className="mt-1 w-full justify-center"
                disabled={compactDisabled}
                onClick={onCompact}
              >
                <Minimize2Icon aria-hidden="true" />
                Compact context
              </Button>
              {compactDisabled && compactDisabledReason ? (
                <div className="text-pretty text-secondary-label text-2xs">
                  {compactDisabledReason}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export function ContextWindowMeterPlaceholder() {
  return <span aria-hidden="true" className="size-7 shrink-0" />;
}
