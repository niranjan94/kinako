import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  HOST_RESOURCES_HISTORY_INPUT,
  HOST_RESOURCES_HISTORY_REFRESH_MS,
  HOST_RESOURCES_REFRESH_MS,
  hostResourceHistoryPaths,
  hostResourceHistorySeries,
  hostResourceMeterDetail,
  hostResourceMeters,
  type HostResourceMeter,
} from "@t3tools/client-runtime/state/host-resources";
import type { EnvironmentId, HostResourcesHistory } from "@t3tools/contracts";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { type ContextType, useContext, useEffect } from "react";

import { cn } from "../../lib/utils";
import { formatBytes } from "../../lib/formatBytes";
import { serverEnvironment } from "../../state/server";

const hostResourcesAtom = (environmentId: EnvironmentId) =>
  serverEnvironment.hostResources({ environmentId, input: {} });
const hostResourcesHistoryAtom = (environmentId: EnvironmentId) =>
  serverEnvironment.hostResourcesHistory({ environmentId, input: HOST_RESOURCES_HISTORY_INPUT });

export function refreshMachineUsage(
  registry: ContextType<typeof RegistryContext>,
  environmentIds: readonly EnvironmentId[],
) {
  for (const environmentId of environmentIds) {
    registry.refresh(hostResourcesAtom(environmentId));
    registry.refresh(hostResourcesHistoryAtom(environmentId));
  }
}

export function UsageMachineSection({
  environments,
}: {
  readonly environments: readonly {
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly isConnected: boolean;
  }[];
}) {
  return (
    <div className="flex flex-col gap-8">
      {environments.map((environment) => (
        <section key={environment.environmentId} className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-foreground">{environment.label}</h2>
          {environment.isConnected ? (
            <MachineMeters environmentId={environment.environmentId} />
          ) : (
            <p className="text-sm text-muted-foreground">This environment is not connected.</p>
          )}
        </section>
      ))}
    </div>
  );
}

function MachineMeters({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const registry = useContext(RegistryContext);
  const result = useAtomValue(hostResourcesAtom(environmentId));
  const historyResult = useAtomValue(hostResourcesHistoryAtom(environmentId));
  const snapshot = AsyncResult.getOrElse(result, () => null);
  const history = AsyncResult.getOrElse(historyResult, () => null);
  // Older servers have no history call; only then do the cards drop the graph's space.
  const showGraph = history !== null || historyResult._tag !== "Failure";

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the environment's machine usage only while the Machine view is mounted
  useEffect(() => {
    const timers = [
      setInterval(
        () => registry.refresh(hostResourcesAtom(environmentId)),
        HOST_RESOURCES_REFRESH_MS,
      ),
      setInterval(
        () => registry.refresh(hostResourcesHistoryAtom(environmentId)),
        HOST_RESOURCES_HISTORY_REFRESH_MS,
      ),
    ];
    return () => timers.forEach(clearInterval);
  }, [registry, environmentId]);

  if (snapshot === null && result._tag === "Failure") {
    return (
      <p className="text-sm text-muted-foreground">
        This environment could not report machine usage.
      </p>
    );
  }
  return (
    <div className="grid gap-3 md:grid-cols-3">
      {snapshot !== null
        ? hostResourceMeters(snapshot).map((meter) => (
            <MeterCard
              key={meter.kind}
              label={meter.label}
              usedFraction={meter.usedFraction}
              detail={hostResourceMeterDetail(meter, formatBytes)}
              history={history}
              showGraph={showGraph}
              kind={meter.kind}
              loading={false}
            />
          ))
        : ["CPU", "Memory", "Disk"].map((label) => (
            <MeterCard
              key={label}
              label={label}
              usedFraction={null}
              detail=""
              history={null}
              showGraph={showGraph}
              loading
            />
          ))}
    </div>
  );
}

function toneOf(percent: number | null) {
  if (percent !== null && percent >= 90)
    return { bar: "bg-destructive", graph: "text-destructive" };
  if (percent !== null && percent >= 75) return { bar: "bg-warning", graph: "text-warning" };
  return { bar: "bg-foreground/60", graph: "text-foreground/60" };
}

function MeterCard({
  label,
  usedFraction,
  detail,
  history,
  showGraph,
  kind,
  loading,
}: {
  readonly label: string;
  readonly usedFraction: number | null;
  readonly detail: string;
  readonly history: HostResourcesHistory | null;
  readonly showGraph: boolean;
  readonly kind?: HostResourceMeter["kind"];
  readonly loading: boolean;
}) {
  const percent = usedFraction === null ? null : Math.round(usedFraction * 100);
  const tone = toneOf(percent);
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-lg border border-border/60 p-4">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className="flex items-baseline gap-2">
          <span
            className={cn(
              "text-3xl font-semibold text-foreground tabular-nums",
              loading && "opacity-40",
            )}
          >
            {percent === null ? "–" : `${percent}%`}
          </span>
          <span className="text-sm text-muted-foreground">used</span>
        </span>
        <span className="min-h-4 truncate text-xs text-muted-foreground tabular-nums">
          {detail}
        </span>
      </div>
      <div
        role="meter"
        aria-label={`${label} used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        className="h-2 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn("h-full rounded-full", tone.bar)}
          style={{ width: `${percent ?? 0}%` }}
        />
      </div>
      {showGraph ? (
        <HistoryGraph
          label={label}
          history={kind === undefined ? null : history}
          kind={kind}
          className={tone.graph}
        />
      ) : null}
    </div>
  );
}

function HistoryGraph({
  label,
  history,
  kind,
  className,
}: {
  readonly label: string;
  readonly history: HostResourcesHistory | null;
  readonly kind: HostResourceMeter["kind"] | undefined;
  readonly className: string;
}) {
  const series =
    history === null || kind === undefined ? null : hostResourceHistorySeries(history, kind);
  const average = series === null ? null : hostResourceHistoryPaths(series.average);
  const peak = series === null ? null : hostResourceHistoryPaths(series.peak);
  const steps = history?.buckets.length ?? 1;
  const hours = Math.round(HOST_RESOURCES_HISTORY_INPUT.windowMs / 3_600_000);
  return (
    <figure className="flex flex-col gap-1">
      <svg
        role="img"
        aria-label={`${label} use over the past ${hours} hours`}
        viewBox={`0 0 ${steps} 100`}
        preserveAspectRatio="none"
        className={cn("h-14 w-full overflow-visible", className)}
      >
        <line
          x1={0}
          x2={steps}
          y1={100}
          y2={100}
          className="stroke-border"
          vectorEffect="non-scaling-stroke"
        />
        {peak !== null && kind !== "disk" ? (
          <path d={peak.area} fill="currentColor" opacity={0.12} />
        ) : null}
        {average !== null ? (
          <>
            <path d={average.area} fill="currentColor" opacity={0.2} />
            <path
              d={average.line}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </>
        ) : null}
      </svg>
      <figcaption className="flex justify-between text-2xs text-muted-foreground">
        <span>{hours}h ago</span>
        <span>now</span>
      </figcaption>
    </figure>
  );
}
