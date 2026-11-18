import { T, useGT, useLocale } from "gt-react";
import { useId, useState } from "react";

import { cn } from "../../lib/utils";
import type { QuotaPoint, QuotaReset } from "./usageQuotaForecast";

const WIDTH = 1_000;
const HEIGHT = 240;

function nearestIndex(points: readonly QuotaPoint[], at: number) {
  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const mid = Math.floor((high + low) / 2);
    const next = points[mid + 1]!;
    if (at < (points[mid]!.at + next.at) / 2) high = mid;
    else low = mid + 1;
  }
  return low;
}

export function QuotaForecastChart({
  from,
  to,
  now,
  capacity,
  recorded,
  projected,
  resets,
  emptyAt,
  drain,
  color,
}: {
  readonly from: number;
  readonly to: number;
  readonly now: number | null;
  readonly capacity: number;
  readonly recorded: readonly (readonly QuotaPoint[])[];
  readonly projected: readonly QuotaPoint[];
  readonly resets: readonly QuotaReset[];
  readonly emptyAt: number | null;
  readonly drain: boolean;
  readonly color: string;
}) {
  const gt = useGT();
  const locale = useLocale();
  const fillId = useId();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const points = [
    ...recorded.flat().map((point) => ({ ...point, isProjected: false })),
    ...projected.map((point) => ({ ...point, isProjected: true })),
  ];
  const hovered = hoverIndex === null ? undefined : points[hoverIndex];
  const x = (at: number) => ((at - from) / (to - from)) * WIDTH;
  const peak = drain ? Math.max(1, ...points.map(({ value }) => value)) : capacity;
  const y = (value: number) => HEIGHT - (value / peak) * HEIGHT;
  const current = now === null ? null : (projected[0] ?? points.at(-1));
  const date = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" });
  const moment = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: drain ? 1 : 0 });
  const amount = (value: number) =>
    drain
      ? gt("{value}%/h", { value: number.format(value) })
      : gt("{value}%", { value: number.format(value) });
  const line = (series: readonly QuotaPoint[]) =>
    series
      .map(
        (point, index) =>
          `${index === 0 ? "M" : "L"}${x(point.at).toFixed(2)},${y(point.value).toFixed(2)}`,
      )
      .join(" ");
  const ticks = Array.from({ length: 8 }, (_, index) => from + ((to - from) * index) / 7);
  const visibleResets = resets.filter(
    (point) =>
      point.at >= from &&
      point.at < to &&
      (!hovered || Math.abs(x(point.at) - x(hovered.at)) < WIDTH / 15),
  );
  const resetLabels: QuotaReset[] = [];
  for (const point of visibleResets) {
    if (point.at - (resetLabels.at(-1)?.at ?? -Infinity) < (to - from) / 15) continue;
    resetLabels.push(point);
  }

  return (
    <div className="mt-7">
      <div className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2 gap-y-2 sm:gap-x-3">
        <div
          aria-hidden
          className="flex flex-col justify-between py-px text-right text-2xs text-muted-foreground tabular-nums"
        >
          {[peak, peak / 2, 0].map((value) => (
            <span key={value}>{amount(value)}</span>
          ))}
        </div>
        <div
          className="relative h-48 rounded-sm focus-within:ring-1 focus-within:ring-inset focus-within:ring-ring sm:h-64"
          onPointerMove={(event) => {
            if (points.length === 0) return;
            const bounds = event.currentTarget.getBoundingClientRect();
            if (bounds.width === 0) return;
            setHoverIndex(
              nearestIndex(
                points,
                from + ((to - from) * (event.clientX - bounds.left)) / bounds.width,
              ),
            );
          }}
          onPointerLeave={() => setHoverIndex(null)}
        >
          <svg
            className="h-full w-full overflow-visible"
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={
              drain ? gt("Recorded quota drain rate") : gt("Recorded and projected quota remaining")
            }
          >
            <defs>
              <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={color} stopOpacity=".23" />
                <stop offset="1" stopColor={color} stopOpacity="0" />
              </linearGradient>
            </defs>
            {[0, HEIGHT / 2, HEIGHT].map((offset) => (
              <path
                key={offset}
                d={`M0,${offset}H${WIDTH}`}
                stroke="currentColor"
                className="text-border"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {ticks.map((at) => (
              <path
                key={at}
                d={`M${x(at)},0V${HEIGHT}`}
                stroke="currentColor"
                className="text-border/50"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {recorded.map((segment) => {
              const first = segment[0]!;
              const last = segment.at(-1)!;
              const path = line(segment);
              return segment.length === 1 ? (
                <path
                  key={first.at}
                  d={`M${x(first.at) - 1},${y(first.value)}h2`}
                  stroke={color}
                  strokeWidth="4"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              ) : (
                <g key={first.at}>
                  {!drain && (
                    <path
                      d={`${path} L${x(last.at)},${HEIGHT} H${x(first.at)} Z`}
                      fill={`url(#${fillId})`}
                    />
                  )}
                  <path
                    d={path}
                    fill="none"
                    stroke={color}
                    strokeWidth="2"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                  />
                </g>
              );
            })}
            {projected.length > 0 && (
              <path
                d={line(projected)}
                fill="none"
                stroke={color}
                strokeWidth="2"
                strokeDasharray="5 4"
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            )}
            {now !== null && (
              <path
                d={`M${x(now)},0V${HEIGHT}`}
                className="text-muted-foreground/60"
                stroke="currentColor"
                vectorEffect="non-scaling-stroke"
              />
            )}
            {hovered && (
              <path
                d={`M${x(hovered.at)},0V${HEIGHT}`}
                stroke={color}
                opacity=".5"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
          {now !== null && (
            <span
              className="pointer-events-none absolute -top-5 -translate-x-1/2 text-2xs text-muted-foreground"
              style={{ left: `${x(now) / 10}%` }}
            >
              <T>Now</T>
            </span>
          )}
          {resetLabels.map(({ at, value, restores }) => (
            <span
              key={at}
              className="pointer-events-none absolute -translate-x-1/2 -translate-y-full rounded-sm bg-card/90 px-0.5 text-2xs text-muted-foreground tabular-nums"
              style={{
                left: `${Math.max(2, Math.min(98, x(at) / 10))}%`,
                top: `${(y(value) / HEIGHT) * 100}%`,
              }}
            >
              +{amount(restores)}
            </span>
          ))}
          {!drain && current && now !== null && (
            <span
              className="pointer-events-none absolute size-2 -translate-1/2 rounded-full ring-2 ring-card"
              style={{
                left: `${x(current.at) / 10}%`,
                top: `${(y(current.value) / HEIGHT) * 100}%`,
                backgroundColor: color,
              }}
            />
          )}
          {emptyAt !== null && emptyAt >= from && emptyAt <= to && (
            <span
              className="pointer-events-none absolute bottom-0 left-0 size-2 -translate-x-1/2 translate-y-1/2 rounded-full border-2 border-foreground bg-card"
              style={{ left: `${x(emptyAt) / 10}%` }}
            />
          )}
          {points.length > 1 && (
            <input
              type="range"
              className="sr-only"
              min={0}
              max={points.length - 1}
              aria-label={gt("Explore quota chart")}
              aria-valuetext={
                hovered ? `${moment.format(hovered.at)} · ${amount(hovered.value)}` : undefined
              }
              value={hoverIndex ?? points.length - 1}
              onFocus={() => setHoverIndex(points.length - 1)}
              onBlur={() => setHoverIndex(null)}
              onChange={(event) => setHoverIndex(event.currentTarget.valueAsNumber)}
            />
          )}
          {hovered && (
            <div
              className={cn(
                "pointer-events-none absolute top-2 z-10 whitespace-nowrap rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-sm",
                x(hovered.at) > WIDTH / 2 ? "left-2" : "right-2",
              )}
            >
              {moment.format(hovered.at)} · {amount(hovered.value)} ·{" "}
              {hovered.isProjected ? <T>Projected</T> : <T>Recorded</T>}
            </div>
          )}
        </div>
        <div />
        <div
          aria-hidden
          className="flex justify-between text-2xs text-muted-foreground tabular-nums"
        >
          {ticks.map((at, index) => (
            <span
              key={at}
              className={
                index % 2 === 1 && index !== ticks.length - 1 ? "hidden sm:inline" : undefined
              }
            >
              {date.format(at)}
            </span>
          ))}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="w-4 border-t-2" style={{ borderColor: color }} />
          <T>Recorded</T>
        </span>
        {!drain && (
          <span className="inline-flex items-center gap-1.5">
            <span className="w-4 border-t-2 border-dashed" style={{ borderColor: color }} />
            <T>Projected</T>
          </span>
        )}
      </div>
    </div>
  );
}
