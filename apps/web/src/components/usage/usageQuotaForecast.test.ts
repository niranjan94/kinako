import { ProviderDriverKind, type UsageQuotaSample } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildQuotaForecast, type QuotaWindow } from "./usageQuotaForecast";

const HOUR = 3_600_000;
const MINUTE = 60_000;
const NOW = Date.parse("2026-11-18T12:00:00Z");
const driver = ProviderDriverKind.make("codex");
const window: QuotaWindow = { key: "weekly", kind: "weekly", label: "Weekly" };

function reading(
  atMins: number,
  used: readonly [number, number],
  options?: { readonly failed?: boolean; readonly firstResetMins?: number; readonly pro?: boolean },
): UsageQuotaSample {
  return {
    checkedAt: new Date(NOW + atMins * MINUTE).toISOString(),
    accounts: used.map((percent, index) => ({
      key: index === 0 ? "first" : "second",
      driver,
      plan:
        index === 0 && options?.pro ? "ChatGPT Pro 100 Subscription" : "ChatGPT Plus Subscription",
      ...(options?.failed && index === 0 ? { unavailable: true } : {}),
      windows: [
        {
          id: "secondary",
          kind: "weekly",
          label: "Weekly",
          usedPercent: percent,
          resetsAt: new Date(
            NOW + (index === 0 ? (options?.firstResetMins ?? 30) : 240) * MINUTE,
          ).toISOString(),
          windowDurationMins: 10_080,
        },
      ],
    })),
  };
}

function forecast(samples: readonly UsageQuotaSample[], multiplier = 1, drain = false) {
  return buildQuotaForecast({
    samples,
    driver,
    window,
    hours: 3,
    multiplier,
    drain,
    now: NOW,
    end: NOW + 3 * HOUR,
  });
}

describe("quota forecast", () => {
  it("projects individual depletion, a refill and eventual pool depletion", () => {
    const samples = [reading(-10, [85, 30]), reading(0, [95, 40])];
    const normal = forecast(samples);
    expect(normal.remaining).toBe(65);
    expect(normal.hourlyBurn).toBe(120);
    expect(normal.projection?.firstEmpty).toEqual({ key: "first", at: NOW + 5 * MINUTE });
    expect(normal.projection?.poolEmpty).toBe(NOW + 130 * MINUTE);
    expect(normal.projection?.refills).toEqual([
      { at: NOW + 30 * MINUTE, value: 130, restores: 100 },
    ]);

    const paused = forecast(samples, 0);
    expect(paused.projection?.firstEmpty).toBeNull();
    expect(paused.projection?.poolEmpty).toBeNull();
    expect(paused.projection?.refills).toEqual([
      { at: NOW + 30 * MINUTE, value: 160, restores: 95 },
    ]);
  });

  it("treats failed or missing readings as gaps instead of forecasting from stale quota", () => {
    const good = reading(-10, [85, 30]);
    const failed = reading(0, [95, 40], { failed: true });
    const result = forecast([good, failed]);
    expect(result.recorded).toEqual([[{ at: NOW - 10 * MINUTE, value: 85 }]]);
    expect(result.remaining).toBe(85);
    expect(result.stale).toBe(true);
    expect(result.hourlyBurn).toBeNull();
    expect(result.projection).toBeNull();

    const disconnected = forecast([reading(-45, [70, 20]), good, reading(0, [95, 40])]);
    expect(disconnected.recorded.map((segment) => segment.length)).toEqual([1, 2]);
    expect(disconnected.hourlyBurn).toBe(120);
  });

  it("uses comparable intervals and plan weights without treating a reset as spending", () => {
    const samples = [
      reading(-20, [90, 20], { firstResetMins: -11, pro: true }),
      reading(-10, [0, 25], { pro: true }),
      reading(0, [10, 30], { pro: true }),
    ];
    const normal = forecast(samples);
    expect(normal.capacity).toBe(600);
    expect(normal.remaining).toBe(520);
    expect(normal.observedResets).toEqual([{ at: NOW - 10 * MINUTE, value: 575, restores: 450 }]);
    expect(normal.hourlyBurn).toBe(330);
    expect(forecast(samples, 1, true).recorded).toEqual([[{ at: NOW, value: 330 }]]);
  });
});
