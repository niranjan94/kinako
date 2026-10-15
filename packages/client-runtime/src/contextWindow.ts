import type {
  OrchestrationV2ContextUsageCategory,
  OrchestrationV2ProviderTurn,
  OrchestrationV2ProviderTurnTokenUsage,
  OrchestrationV2ProviderThread,
  OrchestrationV2TurnItem,
  ThreadTokenUsageSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

type NullableContextWindowUsage = {
  readonly [Key in keyof ThreadTokenUsageSnapshot]: undefined extends ThreadTokenUsageSnapshot[Key]
    ? Exclude<ThreadTokenUsageSnapshot[Key], undefined> | null
    : ThreadTokenUsageSnapshot[Key];
};

export type ContextWindowSnapshot = NullableContextWindowUsage & {
  readonly categories: ReadonlyArray<OrchestrationV2ContextUsageCategory> | null;
  readonly remainingTokens: number | null;
  readonly usedPercentage: number | null;
  readonly remainingPercentage: number | null;
  readonly updatedAt: string;
};

/** Newest usage report across a thread's provider turns. Snapshots order turns
    by provider thread, not time, so pick by timestamp. */
export function latestProviderTurnTokenUsage(
  turns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "tokenUsage">>,
): OrchestrationV2ProviderTurnTokenUsage | null {
  let latest: OrchestrationV2ProviderTurnTokenUsage | null = null;
  for (const { tokenUsage } of turns) {
    if (tokenUsage === undefined) continue;
    // Ties go to the later entry, since live upserts append.
    if (latest === null || Date.parse(tokenUsage.updatedAt) >= Date.parse(latest.updatedAt)) {
      latest = tokenUsage;
    }
  }
  return latest;
}

/** Prefers the provider's live usage report (#8144); falls back to the last compaction item. */
export function deriveLatestContextWindowSnapshot(
  entries: ReadonlyArray<{
    readonly item: OrchestrationV2TurnItem;
  }>,
  liveUsage?: OrchestrationV2ProviderTurnTokenUsage | null,
  providerThread?: Pick<OrchestrationV2ProviderThread, "contextUsage" | "updatedAt"> | null,
): ContextWindowSnapshot | null {
  if (liveUsage != null) {
    const usedTokens = Math.max(0, liveUsage.usedTokens);
    const maxTokens = liveUsage.maxTokens ?? null;
    const usedPercentage =
      maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null;
    const remainingTokens =
      maxTokens !== null ? Math.max(0, Math.round(maxTokens - usedTokens)) : null;
    const remainingPercentage = usedPercentage !== null ? Math.max(0, 100 - usedPercentage) : null;
    return {
      usedTokens,
      totalProcessedTokens: null,
      maxTokens,
      remainingTokens,
      usedPercentage,
      remainingPercentage,
      inputTokens: liveUsage.inputTokens ?? null,
      cachedInputTokens: liveUsage.cachedInputTokens ?? null,
      outputTokens: liveUsage.outputTokens ?? null,
      reasoningOutputTokens: liveUsage.reasoningOutputTokens ?? null,
      lastUsedTokens: null,
      lastInputTokens: null,
      lastCachedInputTokens: null,
      lastOutputTokens: null,
      lastReasoningOutputTokens: null,
      toolUses: null,
      durationMs: null,
      compactsAutomatically: true,
      autoCompactThreshold: null,
      cost: null,
      categories: liveUsage.categories ?? null,
      updatedAt: liveUsage.updatedAt,
    };
  }
  const providerUsage = providerThread?.contextUsage;
  const providerUsageUpdatedAt = providerThread?.updatedAt;
  if (
    providerUsage !== null &&
    providerUsage !== undefined &&
    providerUsageUpdatedAt !== undefined
  ) {
    const maxTokens = asFiniteNumber(providerUsage.maxTokens);
    const usedTokens = providerUsage.usedTokens;
    const usedPercentage =
      maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null;
    return {
      usedTokens,
      totalProcessedTokens: asFiniteNumber(providerUsage.totalProcessedTokens),
      maxTokens,
      remainingTokens: maxTokens === null ? null : Math.max(0, Math.round(maxTokens - usedTokens)),
      usedPercentage,
      remainingPercentage: usedPercentage === null ? null : Math.max(0, 100 - usedPercentage),
      inputTokens: asFiniteNumber(providerUsage.inputTokens),
      cachedInputTokens: asFiniteNumber(providerUsage.cachedInputTokens),
      outputTokens: asFiniteNumber(providerUsage.outputTokens),
      reasoningOutputTokens: asFiniteNumber(providerUsage.reasoningOutputTokens),
      lastUsedTokens: asFiniteNumber(providerUsage.lastUsedTokens),
      lastInputTokens: asFiniteNumber(providerUsage.lastInputTokens),
      lastCachedInputTokens: asFiniteNumber(providerUsage.lastCachedInputTokens),
      lastOutputTokens: asFiniteNumber(providerUsage.lastOutputTokens),
      lastReasoningOutputTokens: asFiniteNumber(providerUsage.lastReasoningOutputTokens),
      toolUses: asFiniteNumber(providerUsage.toolUses),
      durationMs: asFiniteNumber(providerUsage.durationMs),
      compactsAutomatically: providerUsage.compactsAutomatically ?? null,
      cost: providerUsage.cost ?? null,
      autoCompactThreshold: providerUsage.autoCompactThreshold ?? null,
      categories: null,
      updatedAt: DateTime.formatIso(providerUsageUpdatedAt),
    };
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || entry.item.type !== "compaction") {
      continue;
    }
    const payload = entry.item;
    const usedTokens = asFiniteNumber(payload.afterTokenCount);
    if (usedTokens === null || usedTokens < 0) {
      continue;
    }

    const maxTokens = null;
    const usedPercentage =
      maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null;
    const remainingTokens =
      maxTokens !== null ? Math.max(0, Math.round(maxTokens - usedTokens)) : null;
    const remainingPercentage = usedPercentage !== null ? Math.max(0, 100 - usedPercentage) : null;

    return {
      usedTokens,
      totalProcessedTokens: asFiniteNumber(payload.beforeTokenCount),
      maxTokens,
      remainingTokens,
      usedPercentage,
      remainingPercentage,
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      lastUsedTokens: null,
      lastInputTokens: null,
      lastCachedInputTokens: null,
      lastOutputTokens: null,
      lastReasoningOutputTokens: null,
      toolUses: null,
      durationMs: null,
      compactsAutomatically: true,
      autoCompactThreshold: null,
      cost: null,
      categories: null,
      updatedAt: DateTime.formatIso(payload.startedAt ?? payload.updatedAt),
    };
  }

  return null;
}

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
  if (inputTokens == null) return null;
  const cachedTokens = Math.min(snapshot.cachedInputTokens ?? 0, inputTokens);
  const outputTokens = snapshot.outputTokens ?? 0;
  // Some providers count more in their total than the split they report.
  const otherTokens = Math.max(0, snapshot.usedTokens - inputTokens - outputTokens);
  const freeTokens =
    snapshot.maxTokens == null ? 0 : Math.max(0, snapshot.maxTokens - snapshot.usedTokens);
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
  // Anything from 999,500 rounds to 1000k, so it belongs to the next unit.
  if (value < 999_500) {
    return `${Math.round(value / 1_000)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}
