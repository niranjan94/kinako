import type { ContextWindowSnapshot } from "./state/contextWindow.ts";

export type ContextWindowSegmentKind = "used" | "free" | "buffer";

export interface ContextWindowSegment {
  readonly label: string;
  readonly tokens: number;
  readonly kind: ContextWindowSegmentKind;
}

export interface ContextWindowBreakdown {
  /** In window order; their tokens add up to the bar's full width. */
  readonly segments: ReadonlyArray<ContextWindowSegment>;
  /** Listed by the provider but held outside the window, such as deferred tool schemas. */
  readonly deferred: ReadonlyArray<{ readonly label: string; readonly tokens: number }>;
  /** `provider` when the provider itemized its context, `tokens` when only the token split is known. */
  readonly source: "provider" | "tokens";
}

/**
 * What fills the context window. Uses the provider's own categories when it
 * reports them, and otherwise splits the last request into cached input, new
 * input, and output, which every usage-reporting provider gives.
 */
export function deriveContextWindowBreakdown(
  snapshot: ContextWindowSnapshot,
): ContextWindowBreakdown | null {
  if (snapshot.categories !== null && snapshot.categories.length > 0) {
    const segments = snapshot.categories.flatMap((category) =>
      category.kind === "deferred" || category.tokens === 0
        ? []
        : [{ label: category.name, tokens: category.tokens, kind: category.kind }],
    );
    if (segments.length > 0) {
      return {
        segments,
        deferred: snapshot.categories
          .filter((category) => category.kind === "deferred" && category.tokens > 0)
          .map((category) => ({ label: category.name, tokens: category.tokens })),
        source: "provider",
      };
    }
  }

  const inputTokens = snapshot.inputTokens;
  // Without a window size the split has nothing to fill, and a bar of only
  // used segments would read as a full window.
  if (inputTokens == null || snapshot.maxTokens == null) return null;
  const cachedTokens = Math.min(snapshot.cachedInputTokens ?? 0, inputTokens);
  const outputTokens = snapshot.outputTokens ?? 0;
  // Some providers count more in their total than the split they report.
  const otherTokens = Math.max(0, snapshot.usedTokens - inputTokens - outputTokens);
  const freeTokens = Math.max(0, snapshot.maxTokens - snapshot.usedTokens);
  const segments: Array<ContextWindowSegment> = [
    { label: "Cached input", tokens: cachedTokens, kind: "used" },
    { label: "New input", tokens: inputTokens - cachedTokens, kind: "used" },
    { label: "Output", tokens: outputTokens, kind: "used" },
    { label: "Other", tokens: otherTokens, kind: "used" },
    { label: "Free space", tokens: freeTokens, kind: "free" },
  ];
  const visible = segments.filter((segment) => segment.tokens > 0);
  return visible.some((segment) => segment.kind === "used")
    ? { segments: visible, deferred: [], source: "tokens" }
    : null;
}

export function formatContextWindowPercentage(value: number): string {
  return value < 10 ? `${value.toFixed(1).replace(/\.0$/, "")}%` : `${Math.round(value)}%`;
}

export function formatContextWindowTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "0";
  }
  if (value < 1_000) {
    return `${Math.round(value)}`;
  }
  if (value < 10_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  if (value < 999_500) {
    return `${Math.round(value / 1_000)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}
