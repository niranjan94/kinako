import type {
  HostResourcesHistory,
  HostResourcesHistoryBucket,
  HostResourcesSnapshot,
} from "@t3tools/contracts";

export const HOST_RESOURCES_REFRESH_MS = 5_000;
export const HOST_RESOURCES_HISTORY_REFRESH_MS = 30_000;
export const HOST_RESOURCES_HISTORY_INPUT = { windowMs: 24 * 60 * 60_000, bucketMs: 5 * 60_000 };

export type HostResourceMeter =
  | {
      readonly kind: "cpu";
      readonly label: "CPU";
      readonly usedFraction: number | null;
      readonly cpuCount: number;
    }
  | {
      readonly kind: "memory" | "disk";
      readonly label: "Memory" | "Disk";
      readonly usedFraction: number;
      readonly usedBytes: number;
      readonly totalBytes: number;
    };

function byteMeter(kind: "memory" | "disk", availableBytes: number, totalBytes: number) {
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  return {
    kind,
    label: kind === "memory" ? "Memory" : "Disk",
    usedFraction: totalBytes > 0 ? Math.min(1, usedBytes / totalBytes) : 0,
    usedBytes,
    totalBytes,
  } as const;
}

/** CPU, memory, and (when the server reports it) disk usage of an environment's machine. */
export function hostResourceMeters(snapshot: HostResourcesSnapshot): readonly HostResourceMeter[] {
  const meters: HostResourceMeter[] = [
    {
      kind: "cpu",
      label: "CPU",
      usedFraction: snapshot.cpuUtilization,
      cpuCount: snapshot.cpuCount,
    },
    byteMeter("memory", snapshot.availableMemoryBytes, snapshot.totalMemoryBytes),
  ];
  if (snapshot.diskAvailableBytes !== undefined && snapshot.diskTotalBytes !== undefined) {
    meters.push(byteMeter("disk", snapshot.diskAvailableBytes, snapshot.diskTotalBytes));
  }
  return meters;
}

export function hostResourceMeterDetail(
  meter: HostResourceMeter,
  formatBytes: (bytes: number) => string,
) {
  if (meter.kind === "cpu") return `${meter.cpuCount} ${meter.cpuCount === 1 ? "CPU" : "CPUs"}`;
  const detail = `${formatBytes(meter.usedBytes)} of ${formatBytes(meter.totalBytes)}`;
  return meter.kind === "disk" ? `${detail} on the data volume` : detail;
}

type HostResourceSeries = readonly (number | null)[];

export function hostResourceHistorySeries(
  history: HostResourcesHistory,
  kind: HostResourceMeter["kind"],
): { readonly average: HostResourceSeries; readonly peak: HostResourceSeries } {
  const pick = (read: (bucket: HostResourcesHistoryBucket) => number | null) =>
    history.buckets.map((bucket) => (bucket === null ? null : read(bucket)));
  if (kind === "cpu") {
    return { average: pick((b) => b.cpuAverage), peak: pick((b) => b.cpuPeak) };
  }
  if (kind === "memory") {
    return { average: pick((b) => b.memoryAverage), peak: pick((b) => b.memoryPeak) };
  }
  const disk = pick((b) => b.diskUsed);
  return { average: disk, peak: disk };
}

/**
 * Stepped SVG paths in a `0 0 <series length> 100` viewBox, one step per bucket. Gaps (no
 * samples, such as while the server was stopped) break the line instead of bridging it.
 */
export function hostResourceHistoryPaths(series: HostResourceSeries): {
  readonly line: string;
  readonly area: string;
} {
  const line: string[] = [];
  const area: string[] = [];
  let run: string[] = [];
  let runStart = 0;
  const closeRun = (end: number) => {
    if (run.length === 0) return;
    line.push(`M${run.join("L")}`);
    area.push(`M${runStart} 100L${run.join("L")}L${end} 100Z`);
    run = [];
  };
  series.forEach((value, index) => {
    if (value === null) {
      closeRun(index);
      return;
    }
    if (run.length === 0) runStart = index;
    const y = Math.round((1 - Math.min(1, Math.max(0, value))) * 1000) / 10;
    run.push(`${index} ${y}`, `${index + 1} ${y}`);
  });
  closeRun(series.length);
  return { line: line.join(""), area: area.join("") };
}
