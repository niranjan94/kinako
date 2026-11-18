import type {
  ProviderDriverKind,
  ServerProviderUsageWindow,
  UsageLimitSourceSnapshot,
  UsageQuotaSample,
} from "@t3tools/contracts";
import { effectivePoolQuota, limitPoolKey, limitPoolWeights } from "@t3tools/shared/usageLimits";

const HOUR_MS = 3_600_000;
const MAX_GAP_MS = 30 * 60_000;
const MIN_RATE_OBSERVATION_MS = 5 * 60_000;

export interface QuotaWindow {
  readonly key: string;
  readonly label: string;
  readonly kind: ServerProviderUsageWindow["kind"];
}

export interface QuotaPoint {
  readonly at: number;
  readonly value: number;
}

export interface QuotaReset extends QuotaPoint {
  readonly restores: number;
}

export function liveQuotaSample(source: UsageLimitSourceSnapshot): UsageQuotaSample {
  return {
    checkedAt: source.checkedAt,
    accounts: source.accounts.flatMap(({ historyKey, driver, plan, usageLimits }) =>
      historyKey
        ? [
            {
              key: historyKey,
              driver,
              plan,
              windows: usageLimits.windows,
              ...(usageLimits.unavailable ||
              Date.parse(usageLimits.checkedAt) < Date.parse(source.checkedAt)
                ? { unavailable: true }
                : {}),
            },
          ]
        : [],
    ),
  };
}

export function quotaWindows(
  samples: readonly UsageQuotaSample[],
  driver: ProviderDriverKind,
): QuotaWindow[] {
  const windows = new Map<string, QuotaWindow>();
  for (const sample of samples) {
    for (const account of sample.accounts) {
      if (account.driver !== driver) continue;
      for (const window of account.windows) {
        const key = limitPoolKey(driver, window);
        windows.set(key, { key, label: window.label, kind: window.kind });
      }
    }
  }
  const order = { weekly: 0, session: 1, monthly: 2, other: 3 } as const;
  return [...windows.values()].sort((left, right) => order[left.kind] - order[right.kind]);
}

function quotaFrame(sample: UsageQuotaSample, driver: ProviderDriverKind, selected: QuotaWindow) {
  const at = Date.parse(sample.checkedAt);
  const accounts = sample.accounts.filter((account) => account.driver === driver);
  const reports = accounts.flatMap((account) => {
    if (account.unavailable) return [];
    const window = account.windows.find((item) => limitPoolKey(driver, item) === selected.key);
    return window ? [{ account, window }] : [];
  });
  const weights = limitPoolWeights(
    driver,
    selected.kind,
    reports.map(({ account }) => account),
  );
  const members = new Map(
    reports.map(({ account, window }, index) => {
      const effective = effectivePoolQuota(
        {
          driver,
          limits: { checkedAt: sample.checkedAt, windows: account.windows },
        },
        window,
        at,
      );
      return [
        account.key,
        {
          window,
          effective,
          weight: weights[index]!,
        },
      ] as const;
    }),
  );
  return {
    at,
    members,
    complete: members.size > 0 && accounts.every((account) => !account.unavailable),
    capacity: 100 * weights.reduce((sum, weight) => sum + weight, 0),
    remaining: [...members.values()].reduce(
      (sum, { effective, weight }) => sum + (100 - effective.window.usedPercent) * weight,
      0,
    ),
  };
}

type Frame = ReturnType<typeof quotaFrame>;

function samePool(previous: Frame, next: Frame) {
  return (
    previous.complete &&
    next.complete &&
    previous.members.size === next.members.size &&
    [...next.members].every(([key, member]) => previous.members.get(key)?.weight === member.weight)
  );
}

function readRates(frames: readonly Frame[], toIndex: number, hours: number) {
  const latest = frames[toIndex]!;
  const cutoff = latest.at - hours * HOUR_MS;
  const rates = new Map<string, { spent: number; elapsed: number }>();
  for (let index = toIndex; index > 0; index -= 1) {
    const next = frames[index]!;
    const previous = frames[index - 1]!;
    if (next.at <= cutoff) break;
    const duration = next.at - previous.at;
    if (duration <= 0 || duration > MAX_GAP_MS || !samePool(previous, next)) continue;
    const elapsed = next.at - Math.max(previous.at, cutoff);
    for (const [key, member] of next.members) {
      if (!latest.members.has(key)) continue;
      const prior = previous.members.get(key)!;
      const before = prior.window;
      const after = member.window;
      const spent = after.usedPercent - before.usedPercent;
      if (
        prior.effective.window.usedPercent >= 100 ||
        before.resetsAt !== after.resetsAt ||
        spent < 0 ||
        before.windowDurationMins !== after.windowDurationMins
      )
        continue;
      const rate = rates.get(key) ?? { spent: 0, elapsed: 0 };
      rate.spent += (spent * elapsed) / duration;
      rate.elapsed += elapsed;
      rates.set(key, rate);
    }
  }
  return new Map(
    [...rates].flatMap(([key, rate]) =>
      rate.elapsed >= MIN_RATE_OBSERVATION_MS
        ? [[key, (rate.spent * HOUR_MS) / rate.elapsed] as const]
        : [],
    ),
  );
}

function lineSegments(frames: readonly Frame[], values: readonly (number | null)[]) {
  const segments: QuotaPoint[][] = [];
  let segment: QuotaPoint[] = [];
  for (const [index, frame] of frames.entries()) {
    const previous = frames[index - 1];
    const value = values[index];
    if (
      value == null ||
      !previous ||
      frame.at - previous.at > MAX_GAP_MS ||
      !samePool(previous, frame)
    ) {
      segment = [];
    }
    if (value == null) continue;
    if (segment.length === 0) segments.push(segment);
    segment.push({ at: frame.at, value });
  }
  return segments;
}

function projectQuota(
  frame: Frame,
  rates: ReadonlyMap<string, number>,
  multiplier: number,
  now: number,
  end: number,
) {
  const accounts = [...frame.members].map(([key, { window, effective, weight }]) => {
    const reset = Date.parse(effective.window.resetsAt ?? "");
    const nextSessionReset = Date.parse(window.resetsAt ?? "");
    const resets = new Map<number, number>();
    if (reset > frame.at) {
      resets.set(reset, 100 - effective.window.usedPercent + effective.refillPercent);
      if (nextSessionReset > reset) resets.set(nextSessionReset, 100);
    }
    return {
      key,
      remaining: 100 - effective.window.usedPercent,
      weight,
      rate: ((rates.get(key) ?? 0) * multiplier) / HOUR_MS,
      resets,
    };
  });

  const events = [...new Set([now, end, ...accounts.flatMap(({ resets }) => [...resets.keys()])])]
    .filter((at) => at >= frame.at && at <= end)
    .sort((left, right) => left - right);
  const points: QuotaPoint[] = [];
  const refills: QuotaReset[] = [];
  let firstEmpty: { key: string; at: number } | null = null;
  let poolEmpty: number | null = null;
  let start = frame.at;

  for (const at of events) {
    const empty = accounts.map(({ remaining, rate }) =>
      remaining <= 0 ? start : rate > 0 ? start + remaining / rate : Infinity,
    );
    const milestones = [...new Set(empty)]
      .filter((time) => time > start && time < at)
      .sort((left, right) => left - right);
    for (const time of [...milestones, at]) {
      const value = accounts.reduce(
        (sum, account) =>
          sum + Math.max(0, account.remaining - account.rate * (time - start)) * account.weight,
        0,
      );
      if (time >= now) points.push({ at: time, value });
    }
    const first = Math.min(...empty);
    const last = Math.max(...empty);
    if (firstEmpty === null && first <= at) {
      firstEmpty = { key: accounts[empty.indexOf(first)]!.key, at: Math.max(now, first) };
    }
    if (poolEmpty === null && last <= at) poolEmpty = Math.max(now, last);

    let restores = 0;
    let valueAfterReset = 0;
    for (const account of accounts) {
      const before = Math.max(0, account.remaining - account.rate * (at - start));
      account.remaining = account.resets.get(at) ?? before;
      restores += (account.remaining - before) * account.weight;
      valueAfterReset += account.remaining * account.weight;
    }
    if (at >= now && restores > 0) {
      refills.push({ at, value: valueAfterReset, restores });
      points.push({ at, value: valueAfterReset });
    }
    start = at;
  }
  return { points, refills, firstEmpty, poolEmpty };
}

export function buildQuotaForecast({
  samples,
  driver,
  window,
  hours,
  multiplier,
  drain,
  now,
  end,
}: {
  readonly samples: readonly UsageQuotaSample[];
  readonly driver: ProviderDriverKind;
  readonly window: QuotaWindow;
  readonly hours: number;
  readonly multiplier: number;
  readonly drain: boolean;
  readonly now: number;
  readonly end: number;
}) {
  const frames = samples.map((sample) => quotaFrame(sample, driver, window));
  const latest = frames.at(-1);
  const good = frames.findLast((frame) => frame.complete);
  const rates = latest?.complete
    ? readRates(frames, frames.length - 1, hours)
    : new Map<string, number>();
  const rateFor = (frame: Frame, ratesAt: ReadonlyMap<string, number>) =>
    frame.complete && ratesAt.size === frame.members.size
      ? [...frame.members].reduce(
          (sum, [key, { weight }]) => sum + (ratesAt.get(key) ?? 0) * weight,
          0,
        )
      : null;
  const hourlyBurn = latest ? rateFor(latest, rates) : null;
  const fresh = latest?.complete === true && now - latest.at <= MAX_GAP_MS;
  const missingReset =
    latest &&
    [...latest.members.values()].some(
      ({ window: raw }) => raw.resetsAt !== undefined && Date.parse(raw.resetsAt) <= now,
    );
  const projection =
    latest && fresh && !missingReset && (hourlyBurn !== null || multiplier === 0) && end > now
      ? projectQuota(latest, rates, multiplier, now, end)
      : null;
  const exhausted =
    fresh && !missingReset
      ? [...latest.members].find(([, member]) => member.effective.window.usedPercent >= 100)?.[0]
      : undefined;
  const recorded = lineSegments(
    frames,
    frames.map((frame, index) => {
      if (!frame.complete) return null;
      return drain ? rateFor(frame, readRates(frames, index, hours)) : frame.remaining;
    }),
  );
  const observedResets = drain
    ? []
    : frames.flatMap((frame, index): QuotaReset[] => {
        const previous = frames[index - 1];
        if (!previous || !samePool(previous, frame) || frame.at - previous.at > MAX_GAP_MS)
          return [];
        const increase = [...frame.members].reduce(
          (sum, [key, member]) =>
            sum +
            Math.max(
              0,
              previous.members.get(key)!.effective.window.usedPercent -
                member.effective.window.usedPercent,
            ) *
              member.weight,
          0,
        );
        return increase > 0 ? [{ at: frame.at, value: frame.remaining, restores: increase }] : [];
      });

  return {
    recorded,
    observedResets,
    remaining: good?.remaining,
    capacity: good?.capacity,
    chartCapacity: Math.max(
      100,
      ...frames.filter((frame) => frame.complete).map(({ capacity }) => capacity),
    ),
    hourlyBurn: fresh ? hourlyBurn : null,
    projection,
    firstEmpty: projection?.firstEmpty ?? (exhausted ? { key: exhausted, at: now } : null),
    poolEmpty: projection?.poolEmpty ?? (exhausted && latest?.remaining === 0 ? now : null),
    stale: good !== undefined && (!fresh || missingReset === true),
    accounts: good?.members,
    rates,
  };
}
