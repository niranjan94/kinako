import * as NodeOS from "node:os";
import type {
  HostResourcesHistory,
  HostResourcesHistoryInput,
  HostResourcesSnapshot,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { ServerConfig } from "../config.ts";
import { readDiskSpace } from "../diskSpace.ts";

export class HostResources extends Context.Service<
  HostResources,
  {
    readonly read: Effect.Effect<HostResourcesSnapshot>;
    readonly history: (input: HostResourcesHistoryInput) => Effect.Effect<HostResourcesHistory>;
  }
>()("t3/resourceTelemetry/HostResources") {}

// Linux CPU list syntax, as in Cpus_allowed_list: "0-3,8,10-11".
function parseCpuList(list: string): ReadonlySet<number> | null {
  const cpus = new Set<number>();
  for (const range of list.split(",")) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(range.trim());
    if (!match) return null;
    for (let cpu = Number(match[1]); cpu <= Number(match[2] ?? match[1]); cpu++) cpus.add(cpu);
  }
  return cpus;
}

// os.cpus() compacts online CPUs, so its indices are not CPU ids; /proc/stat lines are keyed.
function pinnedCpu(stat: string, allowed: ReadonlySet<number>) {
  const cpu = { idle: 0, total: 0, count: 0 };
  for (const [, id, fields] of stat.matchAll(/^cpu(\d+) (.+)$/gm)) {
    if (!allowed.has(Number(id))) continue;
    const counters = (fields ?? "").trim().split(/\s+/).map(Number);
    const at = (index: number) => counters[index] ?? 0;
    // user nice system idle iowait irq softirq steal
    const idle = at(3) + at(4);
    cpu.idle += idle;
    cpu.total += idle + at(0) + at(1) + at(2) + at(5) + at(6) + at(7);
    cpu.count++;
  }
  return cpu.count > 0 ? cpu : null;
}

function readCpu() {
  const cpus = NodeOS.cpus();
  const cpu = cpus.reduce(
    (sum, { times }) => ({
      idle: sum.idle + times.idle,
      total: sum.total + times.user + times.nice + times.sys + times.idle + times.irq,
    }),
    { idle: 0, total: 0 },
  );
  return { ...cpu, count: cpus.length };
}

function darwinAvailableMemory(output: string): number | null {
  const pageSize = /page size of (\d+) bytes/.exec(output)?.[1];
  const free = /^Pages free:\s+(\d+)\./m.exec(output)?.[1];
  const inactive = /^Pages inactive:\s+(\d+)\./m.exec(output)?.[1];
  const speculative = /^Pages speculative:\s+(\d+)\./m.exec(output)?.[1];
  if (!pageSize || !free || !inactive || !speculative) return null;
  // vm_stat excludes speculative from free; add it once, without overlapping purgeable pages.
  const available = (Number(free) + Number(inactive) + Number(speculative)) * Number(pageSize);
  return Number.isSafeInteger(available) && Number(pageSize) > 0 ? available : null;
}

function cgroupNumber(text: string, pattern: RegExp): number | null {
  const value = pattern.exec(text)?.[1];
  return value === undefined ? null : Number(value);
}

const HISTORY_SAMPLE_INTERVAL_MS = 30_000;
const HISTORY_WINDOW_MS = 24 * 60 * 60_000;
const HISTORY_CAPACITY = HISTORY_WINDOW_MS / HISTORY_SAMPLE_INTERVAL_MS;
const MAX_HISTORY_BUCKETS = 500;

const round = (fraction: number) => Math.round(fraction * 1000) / 1000;

function usedMemoryFraction(snapshot: HostResourcesSnapshot) {
  return snapshot.totalMemoryBytes > 0
    ? 1 - snapshot.availableMemoryBytes / snapshot.totalMemoryBytes
    : 0;
}

function usedDiskFraction(snapshot: HostResourcesSnapshot) {
  return snapshot.diskTotalBytes !== undefined &&
    snapshot.diskAvailableBytes !== undefined &&
    snapshot.diskTotalBytes > 0
    ? 1 - snapshot.diskAvailableBytes / snapshot.diskTotalBytes
    : null;
}

/** Buckets on a grid aligned to `bucketMs`, so repeated reads keep each bar's time range. */
export function bucketHostResourcesHistory(
  samples: ReadonlyArray<HostResourcesSnapshot>,
  input: HostResourcesHistoryInput & { readonly now: number },
): HostResourcesHistory {
  const windowMs = Math.min(HISTORY_WINDOW_MS, input.windowMs);
  const bucketMs = Math.max(
    HISTORY_SAMPLE_INTERVAL_MS,
    input.bucketMs,
    Math.ceil(windowMs / MAX_HISTORY_BUCKETS),
  );
  const count = Math.ceil(windowMs / bucketMs);
  const endsAt = Math.ceil((input.now + 1) / bucketMs) * bucketMs;
  const startsAt = endsAt - count * bucketMs;
  const groups: HostResourcesSnapshot[][] = Array.from({ length: count }, () => []);
  for (const sample of samples) {
    if (sample.sampledAt < startsAt || sample.sampledAt >= endsAt) continue;
    groups[Math.floor((sample.sampledAt - startsAt) / bucketMs)]!.push(sample);
  }
  return {
    sampleIntervalMs: HISTORY_SAMPLE_INTERVAL_MS,
    bucketMs,
    endsAt,
    buckets: groups.map((group) => {
      const last = group.at(-1);
      if (last === undefined) return null;
      const cpu = group.flatMap((sample) =>
        sample.cpuUtilization === null ? [] : [sample.cpuUtilization],
      );
      const memory = group.map(usedMemoryFraction);
      const disk = usedDiskFraction(last);
      return {
        cpuAverage: cpu.length === 0 ? null : round(cpu.reduce((a, b) => a + b, 0) / cpu.length),
        cpuPeak: cpu.length === 0 ? null : round(Math.max(...cpu)),
        memoryAverage: round(memory.reduce((a, b) => a + b, 0) / memory.length),
        memoryPeak: round(Math.max(...memory)),
        diskUsed: disk === null ? null : round(disk),
      };
    }),
  };
}

const make = Effect.fn("makeHostResources")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const { baseDir } = yield* ServerConfig;

  const readFile = (path: string) => fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""));

  const readCounters = Effect.fn("HostResources.readCounters")(function* () {
    // cgroup v2 only; limits of the server's own cgroup, which is `/` inside a container.
    const cgroupPath =
      platform === "linux"
        ? /^0::(\/.*)$/m.exec(yield* readFile("/proc/self/cgroup"))?.[1]
        : undefined;
    const cgroup =
      cgroupPath === undefined ? null : `/sys/fs/cgroup${cgroupPath.replace(/\/$/, "")}`;
    const cpuMax = cgroup
      ? /^(\d+) (\d+)$/.exec((yield* readFile(`${cgroup}/cpu.max`)).trim())
      : null;
    // Affinity (cpuset) pins the server to some CPUs; idle CPUs outside it are of no use.
    const allowedCpus =
      platform === "linux"
        ? parseCpuList(
            /^Cpus_allowed_list:\s*(\S+)$/m.exec(yield* readFile("/proc/self/status"))?.[1] ?? "",
          )
        : null;
    const cpu = allowedCpus
      ? (pinnedCpu(yield* readFile("/proc/stat"), allowedCpus) ?? readCpu())
      : readCpu();
    const cgroupUsageMicros = cpuMax
      ? cgroupNumber(yield* readFile(`${cgroup}/cpu.stat`), /^usage_usec (\d+)$/m)
      : null;
    return { cgroup, cpuMax, cpu, cgroupUsageMicros, readAtMs: yield* Clock.currentTimeMillis };
  });
  type CpuCounters = Effect.Success<ReturnType<typeof readCounters>>;

  /** Samples memory and disk now, and CPU averaged since `previous`. */
  const sampleSince = Effect.fn("HostResources.sampleSince")(function* (previous: CpuCounters) {
    const counters = yield* readCounters();
    const { cgroup, cpuMax, cpu } = counters;
    const elapsedMicros = (counters.readAtMs - previous.readAtMs) * 1000;
    const totalDelta = cpu.total - previous.cpu.total;
    const idleDelta = cpu.idle - previous.cpu.idle;
    let cpuCount = cpu.count;
    const hostUtilization =
      previous.cpu.count === cpu.count && totalDelta > 0 && idleDelta >= 0
        ? Math.min(1, Math.max(0, 1 - idleDelta / totalDelta))
        : null;
    let cpuUtilization = hostUtilization;
    if (cpuMax) {
      const capacity = Math.min(Number(cpuMax[1]) / Number(cpuMax[2]), cpu.count);
      cpuCount = Math.max(1, Math.floor(capacity));
      const cgroupIdle =
        previous.cgroupUsageMicros !== null &&
        counters.cgroupUsageMicros !== null &&
        elapsedMicros > 0
          ? capacity - (counters.cgroupUsageMicros - previous.cgroupUsageMicros) / elapsedMicros
          : null;
      // Agents can run in sibling cgroups (agentScope.ts), so a busy host still counts.
      const hostIdle = hostUtilization === null ? null : cpu.count * (1 - hostUtilization);
      const idle =
        cgroupIdle === null || hostIdle === null
          ? (cgroupIdle ?? hostIdle)
          : Math.min(cgroupIdle, hostIdle);
      cpuUtilization = idle === null ? null : Math.min(1, Math.max(0, 1 - idle / capacity));
    }
    let totalMemoryBytes = NodeOS.totalmem();
    // On Windows libuv returns GlobalMemoryStatusEx.ullAvailPhys, including standby memory.
    let availableMemoryBytes = NodeOS.freemem();
    if (platform === "linux") {
      const meminfo = yield* readFile("/proc/meminfo");
      const available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo)?.[1];
      if (available) availableMemoryBytes = Number(available) * 1024;
    } else if (platform === "darwin") {
      const output = yield* spawner
        .string(ChildProcess.make("/usr/bin/vm_stat", [], { stdin: "ignore", stderr: "ignore" }))
        .pipe(
          Effect.timeout("1 second"),
          Effect.orElseSucceed(() => ""),
        );
      availableMemoryBytes = darwinAvailableMemory(output) ?? availableMemoryBytes;
    }
    const memoryMax = cgroup
      ? cgroupNumber(yield* readFile(`${cgroup}/memory.max`), /^(\d+)$/m)
      : null;
    const memoryCurrent =
      memoryMax === null
        ? null
        : cgroupNumber(yield* readFile(`${cgroup}/memory.current`), /^(\d+)$/m);
    // Without usage, a capped total would read as a near-empty cgroup; keep host values instead.
    if (memoryMax !== null && memoryCurrent !== null) {
      totalMemoryBytes = Math.min(totalMemoryBytes, memoryMax);
      // inactive_file is page cache the kernel reclaims before hitting memory.max.
      const stat = yield* readFile(`${cgroup}/memory.stat`);
      const reclaimable = cgroupNumber(stat, /^inactive_file (\d+)$/m) ?? 0;
      availableMemoryBytes = Math.min(
        availableMemoryBytes,
        memoryMax - (memoryCurrent - reclaimable),
      );
    }
    const disk = yield* readDiskSpace(baseDir).pipe(
      Effect.map((space) => ({
        diskAvailableBytes: space.availableBytes,
        diskTotalBytes: space.totalBytes,
      })),
      Effect.orElseSucceed(() => ({})),
    );
    const snapshot: HostResourcesSnapshot = {
      sampledAt: DateTime.toEpochMillis(yield* DateTime.now),
      cpuUtilization,
      cpuCount,
      availableMemoryBytes: Math.min(totalMemoryBytes, Math.max(0, availableMemoryBytes)),
      totalMemoryBytes,
      ...disk,
    };
    return { snapshot, counters };
  });

  const cache = yield* Cache.make({
    capacity: 1,
    lookup: (_key: "host") =>
      readCounters().pipe(
        Effect.flatMap((previous) => Effect.delay(sampleSince(previous), "200 millis")),
        Effect.map(({ snapshot }) => snapshot),
      ),
    timeToLive: "5 seconds",
  });

  const history: HostResourcesSnapshot[] = [];
  let previous: CpuCounters | null = null;
  const recordHistory = Effect.gen(function* () {
    if (previous === null) {
      previous = yield* readCounters();
      return;
    }
    const { snapshot, counters } = yield* sampleSince(previous);
    previous = counters;
    history.push(snapshot);
    if (history.length > HISTORY_CAPACITY) history.splice(0, history.length - HISTORY_CAPACITY);
  });
  yield* Effect.sleep(HISTORY_SAMPLE_INTERVAL_MS).pipe(
    Effect.andThen(recordHistory),
    Effect.forever,
    Effect.forkScoped,
  );

  return HostResources.of({
    read: Cache.get(cache, "host"),
    history: Effect.fn("HostResources.history")(function* (input) {
      return bucketHostResourcesHistory(history, { ...input, now: yield* Clock.currentTimeMillis });
    }),
  });
});

export const layer = Layer.effect(HostResources, make());
