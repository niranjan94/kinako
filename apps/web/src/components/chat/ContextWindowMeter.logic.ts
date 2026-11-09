import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

export function threadShellHasStarted(
  shell:
    | Pick<EnvironmentThreadShell, "latestRun" | "latestUserMessageAt" | "runtime">
    | null
    | undefined,
): boolean {
  return Boolean(
    shell &&
    (shell.latestRun !== null || shell.latestUserMessageAt !== null || shell.runtime !== null),
  );
}

export function shouldReserveContextWindowMeter(input: {
  readonly meterEnabled: boolean;
  /** A started thread's detail is still loading. */
  readonly detailLoading: boolean;
  readonly providerReportsContextWindow: boolean | null;
}): boolean {
  return input.meterEnabled && input.detailLoading && input.providerReportsContextWindow !== false;
}

export function formatContextWindowCost(cost: {
  readonly amount: number;
  readonly currency: string;
}): string {
  const fractionDigits = Math.abs(cost.amount) > 0 && Math.abs(cost.amount) < 0.01 ? 4 : 2;
  return `${cost.currency} ${cost.amount.toFixed(fractionDigits)}`;
}

const USED_SEGMENT_COLORS = [
  "var(--color-info)",
  "var(--color-warning)",
  "var(--color-success)",
  "var(--color-update)",
  "color-mix(in oklab, var(--color-info) 55%, var(--color-muted-foreground))",
  "color-mix(in oklab, var(--color-warning) 55%, var(--color-muted-foreground))",
  "color-mix(in oklab, var(--color-success) 55%, var(--color-muted-foreground))",
  "color-mix(in oklab, var(--color-update) 55%, var(--color-muted-foreground))",
];

/** Bar and legend color for a breakdown segment; `usedIndex` counts only used segments. */
export function contextWindowSegmentColor(
  kind: "used" | "free" | "buffer",
  usedIndex: number,
): string {
  if (kind === "free") return "color-mix(in oklab, var(--color-muted-foreground) 18%, transparent)";
  if (kind === "buffer")
    return "color-mix(in oklab, var(--color-muted-foreground) 45%, transparent)";
  return USED_SEGMENT_COLORS[usedIndex % USED_SEGMENT_COLORS.length]!;
}
