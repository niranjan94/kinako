import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import {
  deriveContextWindowBreakdown,
  deriveLatestContextWindowSnapshot,
  formatContextWindowTokens,
  latestProviderTurnTokenUsage,
} from "./contextWindow.ts";

describe("V2 context window presentation", () => {
  it("uses retained compaction token data when available", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      {
        item: {
          id: "compaction-1" as never,
          threadId: "thread-1" as never,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: null,
          completedAt: null,
          updatedAt: DateTime.makeUnsafe("2026-06-20T00:00:00.000Z"),
          type: "compaction",
          driver: null,
          beforeTokenCount: 10_000,
          afterTokenCount: 2_000,
        },
      },
    ]);
    expect(snapshot?.usedTokens).toBe(2_000);
    expect(snapshot?.totalProcessedTokens).toBe(10_000);
  });

  it("prefers current provider usage and preserves ACP cost", () => {
    const snapshot = deriveLatestContextWindowSnapshot([], undefined, {
      contextUsage: {
        usedTokens: 2_500,
        maxTokens: 10_000,
        cost: { amount: 0.42, currency: "USD" },
      },
      updatedAt: DateTime.makeUnsafe("2026-08-23T00:00:00.000Z"),
    });

    expect(snapshot).toMatchObject({
      usedTokens: 2_500,
      maxTokens: 10_000,
      remainingTokens: 7_500,
      usedPercentage: 25,
      cost: { amount: 0.42, currency: "USD" },
    });
  });

  it("formats compact token values", () => {
    expect(formatContextWindowTokens(1_500)).toBe("1.5k");
  });

  it.each([
    [999_499, "999k"],
    [999_500, "1m"],
    [999_999, "1m"],
    [1_000_000, "1m"],
    [1_100_000, "1.1m"],
  ])("formats %d tokens as %s at the million boundary", (tokens, expected) => {
    expect(formatContextWindowTokens(tokens)).toBe(expected);
  });
});

describe("live provider-turn usage (#8144)", () => {
  it("prefers the provider's live report over compaction items", () => {
    const snapshot = deriveLatestContextWindowSnapshot([], {
      usedTokens: 42_000,
      maxTokens: 200_000,
      inputTokens: 40_000,
      outputTokens: 2_000,
      updatedAt: "2026-08-27T00:00:00.000Z",
    });
    expect(snapshot).not.toBeNull();
    expect(snapshot?.usedTokens).toBe(42_000);
    expect(snapshot?.maxTokens).toBe(200_000);
    expect(snapshot?.remainingTokens).toBe(158_000);
    expect(snapshot?.usedPercentage).toBe(21);
  });

  it("handles a report without a known context window", () => {
    const snapshot = deriveLatestContextWindowSnapshot([], {
      usedTokens: 42_000,
      updatedAt: "2026-08-27T00:00:00.000Z",
    });
    expect(snapshot?.maxTokens).toBeNull();
    expect(snapshot?.usedPercentage).toBeNull();
  });
});

describe("latestProviderTurnTokenUsage", () => {
  it("picks the newest report, not the last turn in snapshot order", () => {
    const usage = (usedTokens: number, updatedAt: string) => ({
      tokenUsage: { usedTokens, updatedAt },
    });
    // Snapshots sort by provider thread id, so an older thread can come last.
    const latest = latestProviderTurnTokenUsage([
      usage(300_000, "2026-06-20T12:00:00.000Z"),
      {},
      usage(90_000, "2026-06-20T09:00:00.000Z"),
    ]);
    expect(latest?.usedTokens).toBe(300_000);
  });
});

describe("deriveContextWindowBreakdown", () => {
  it("uses the provider's categories and keeps deferred rows out of the window", () => {
    const snapshot = deriveLatestContextWindowSnapshot([], {
      usedTokens: 37_200,
      maxTokens: 1_000_000,
      categories: [
        { name: "System prompt", tokens: 8_100, kind: "used" },
        { name: "Messages", tokens: 29_100, kind: "used" },
        { name: "Skills", tokens: 0, kind: "used" },
        { name: "Compact buffer", tokens: 3_000, kind: "buffer" },
        { name: "Free space", tokens: 959_800, kind: "free" },
        { name: "MCP tools (deferred)", tokens: 58_800, kind: "deferred" },
      ],
      updatedAt: "2026-10-15T00:00:00.000Z",
    });
    expect(deriveContextWindowBreakdown(snapshot!)).toEqual({
      source: "provider",
      segments: [
        { label: "System prompt", tokens: 8_100, kind: "used" },
        { label: "Messages", tokens: 29_100, kind: "used" },
        { label: "Compact buffer", tokens: 3_000, kind: "buffer" },
        { label: "Free space", tokens: 959_800, kind: "free" },
      ],
      deferred: [{ label: "MCP tools (deferred)", tokens: 58_800 }],
    });
  });

  it("splits the token counts when the provider reports no categories", () => {
    const snapshot = deriveLatestContextWindowSnapshot([], {
      usedTokens: 50_000,
      maxTokens: 200_000,
      inputTokens: 45_000,
      cachedInputTokens: 40_000,
      outputTokens: 4_000,
      updatedAt: "2026-10-15T00:00:00.000Z",
    });
    expect(deriveContextWindowBreakdown(snapshot!)).toEqual({
      source: "tokens",
      segments: [
        { label: "Cached input", tokens: 40_000, kind: "used" },
        { label: "New input", tokens: 5_000, kind: "used" },
        { label: "Output", tokens: 4_000, kind: "used" },
        { label: "Other", tokens: 1_000, kind: "used" },
        { label: "Free space", tokens: 150_000, kind: "free" },
      ],
      deferred: [],
    });
  });

  it("has nothing to break down when only the total is known", () => {
    const snapshot = deriveLatestContextWindowSnapshot([], {
      usedTokens: 42_000,
      maxTokens: 200_000,
      updatedAt: "2026-10-15T00:00:00.000Z",
    });
    expect(deriveContextWindowBreakdown(snapshot!)).toBeNull();
  });
});
