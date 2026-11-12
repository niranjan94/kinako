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
import { type ColorValue, View } from "react-native";
import Svg, { Line, Path } from "react-native-svg";
import { useResolveClassNames } from "uniwind";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { formatBytes } from "../../lib/formatBytes";
import { serverEnvironment } from "../../state/server";
import { SettingsSection } from "../settings/components/SettingsSection";

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

export function UsageMachineSection(props: {
  readonly environments: readonly {
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly isConnected: boolean;
  }[];
  readonly active: boolean;
}) {
  return (
    <>
      {props.environments.map((environment) => (
        <SettingsSection key={environment.environmentId} title={environment.label}>
          {environment.isConnected ? (
            <MachineMeters environmentId={environment.environmentId} active={props.active} />
          ) : (
            <Text className="p-4 text-sm text-foreground-muted">
              This environment is not connected.
            </Text>
          )}
        </SettingsSection>
      ))}
    </>
  );
}

function MachineMeters(props: { readonly environmentId: EnvironmentId; readonly active: boolean }) {
  const { environmentId, active } = props;
  const registry = useContext(RegistryContext);
  const result = useAtomValue(hostResourcesAtom(environmentId));
  const historyResult = useAtomValue(hostResourcesHistoryAtom(environmentId));
  const snapshot = AsyncResult.getOrElse(result, () => null);
  const history = AsyncResult.getOrElse(historyResult, () => null);
  // Older servers have no history call; only then do the rows drop the graph's space.
  const showGraph = history !== null || historyResult._tag !== "Failure";

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the environment's machine usage only while the Machine view is focused
  useEffect(() => {
    if (!active) return;
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
  }, [registry, environmentId, active]);

  if (snapshot === null && result._tag === "Failure") {
    return (
      <Text className="p-4 text-sm text-foreground-muted">
        This environment could not report machine usage.
      </Text>
    );
  }
  return (
    <>
      {snapshot === null
        ? ["CPU", "Memory", "Disk"].map((label, index) => (
            <MeterRow
              key={label}
              label={label}
              usedFraction={null}
              detail=""
              history={null}
              showGraph={showGraph}
              first={index === 0}
            />
          ))
        : hostResourceMeters(snapshot).map((meter, index) => (
            <MeterRow
              key={meter.kind}
              label={meter.label}
              usedFraction={meter.usedFraction}
              detail={hostResourceMeterDetail(meter, formatBytes)}
              kind={meter.kind}
              history={history}
              showGraph={showGraph}
              first={index === 0}
            />
          ))}
    </>
  );
}

function toneOf(percent: number | null) {
  if (percent !== null && percent >= 90) return { bar: "bg-red-500", text: "text-red-500" };
  if (percent !== null && percent >= 75) return { bar: "bg-amber-500", text: "text-amber-500" };
  return { bar: "bg-foreground", text: "text-foreground" };
}

function MeterRow(props: {
  readonly label: string;
  readonly usedFraction: number | null;
  readonly detail: string;
  readonly kind?: HostResourceMeter["kind"];
  readonly history: HostResourcesHistory | null;
  readonly showGraph: boolean;
  readonly first: boolean;
}) {
  const percent = props.usedFraction === null ? null : Math.round(props.usedFraction * 100);
  const tone = toneOf(percent);
  const { color } = useResolveClassNames(tone.text);
  return (
    <View className={cn("gap-2 p-4", !props.first && "border-t border-border-subtle")}>
      <View className="flex-row items-baseline justify-between gap-3">
        <Text className="text-base text-foreground">{props.label}</Text>
        <Text className="text-base tabular-nums text-foreground">
          {percent === null ? "–" : `${percent}% used`}
        </Text>
      </View>
      <View className="h-1.5 flex-row overflow-hidden rounded-full bg-subtle">
        <View className={cn("h-full rounded-full", tone.bar)} style={{ flex: percent ?? 0 }} />
        <View style={{ flex: 100 - (percent ?? 0) }} />
      </View>
      <Text className="min-h-5 text-sm text-foreground-muted">{props.detail}</Text>
      {props.showGraph ? (
        <HistoryGraph
          label={props.label}
          kind={props.kind}
          history={props.kind === undefined ? null : props.history}
          color={color}
        />
      ) : null}
    </View>
  );
}

function HistoryGraph(props: {
  readonly label: string;
  readonly kind: HostResourceMeter["kind"] | undefined;
  readonly history: HostResourcesHistory | null;
  readonly color: ColorValue | undefined;
}) {
  const { kind, history, color } = props;
  const series =
    history === null || kind === undefined ? null : hostResourceHistorySeries(history, kind);
  const average = series === null ? null : hostResourceHistoryPaths(series.average);
  const peak = series === null ? null : hostResourceHistoryPaths(series.peak);
  const width = history?.buckets.length ?? 1;
  const hours = Math.round(HOST_RESOURCES_HISTORY_INPUT.windowMs / 3_600_000);
  return (
    <View
      className="gap-1"
      accessible
      accessibilityLabel={`${props.label} use over the past ${hours} hours`}
    >
      <Svg width="100%" height={48} viewBox={`0 0 ${width} 100`} preserveAspectRatio="none">
        <Line
          x1={0}
          x2={width}
          y1={100}
          y2={100}
          stroke={color}
          strokeOpacity={0.25}
          vectorEffect="non-scaling-stroke"
        />
        {peak !== null && kind !== "disk" ? (
          <Path d={peak.area} fill={color} fillOpacity={0.12} />
        ) : null}
        {average !== null ? (
          <>
            <Path d={average.area} fill={color} fillOpacity={0.2} />
            <Path
              d={average.line}
              fill="none"
              stroke={color}
              strokeWidth={1.5}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </>
        ) : null}
      </Svg>
      <View className="flex-row justify-between">
        <Text className="text-xs text-foreground-tertiary">{hours}h ago</Text>
        <Text className="text-xs text-foreground-tertiary">now</Text>
      </View>
    </View>
  );
}
