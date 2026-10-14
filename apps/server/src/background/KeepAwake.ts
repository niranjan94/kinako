import type {
  KeepAwakeMode,
  OrchestrationV2DomainEvent,
  RunId,
  ServerKeepAwakeStatus,
} from "@t3tools/contracts";
import { FORK_DISPLAY_NAME } from "@t3tools/shared/forkBrand";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as PlatformError from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";

export class KeepAwake extends Context.Service<
  KeepAwake,
  {
    readonly status: Stream.Stream<ServerKeepAwakeStatus>;
  }
>()("t3/background/KeepAwake") {}

// Back-to-back turns would otherwise restart the helper between every run.
const RELEASE_GRACE = Duration.seconds(30);
// One restart after the helper fails, then report the error until the mode changes.
const MAX_HELPER_FAILURES = 2;
// A helper that stayed up this long was working, so its exit starts a fresh failure count.
const HEALTHY_HELPER_UPTIME = Duration.minutes(1);

interface KeepAwakeCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

// ES_CONTINUOUS | ES_SYSTEM_REQUIRED, held by the PowerShell thread until the
// server exits or the helper is killed.
const windowsKeepAwakeScript = (serverPid: number) =>
  [
    `Add-Type -Namespace KeepAwake -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'`,
    "[void][KeepAwake.Power]::SetThreadExecutionState([uint32]2147483649)",
    `Wait-Process -Id ${serverPid}`,
  ].join("\n");

/**
 * The helper that blocks system sleep on this host, or null when there is
 * none. Every helper also exits when the server process does, so a crash
 * never leaves the machine pinned awake.
 */
export const resolveKeepAwakeCommand = Effect.fn("KeepAwake.resolveCommand")(function* (
  serverPid: number,
) {
  const platform = yield* HostProcess.Platform;
  switch (platform) {
    case "darwin":
      // No -d: agents do not need the display on.
      return {
        command: "/usr/bin/caffeinate",
        args: ["-i", "-s", "-w", String(serverPid)],
      } satisfies KeepAwakeCommand;
    case "linux": {
      // logind inside WSL cannot stop the Windows host from sleeping.
      const env = yield* HostProcess.Environment;
      if (env.WSL_DISTRO_NAME !== undefined || env.WSL_INTEROP !== undefined) return null;
      const systemdInhibit = yield* resolveCommandPath("systemd-inhibit");
      if (systemdInhibit === null) return null;
      return {
        command: systemdInhibit,
        args: [
          "--what=sleep:idle",
          `--who=${FORK_DISPLAY_NAME}`,
          "--why=Keep awake is on",
          "--mode=block",
          "tail",
          `--pid=${serverPid}`,
          "-f",
          "/dev/null",
        ],
      } satisfies KeepAwakeCommand;
    }
    case "win32":
      return {
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(windowsKeepAwakeScript(serverPid), "utf16le").toString("base64"),
        ],
      } satisfies KeepAwakeCommand;
    default:
      return null;
  }
});

function isKeepAwakeDesired(mode: KeepAwakeMode, activeRunCount: number): boolean {
  return mode === "always" || (mode === "agent" && activeRunCount > 0);
}

// Thread deletion emits a terminal run.updated for each active run, so run events suffice.
function foldActiveRuns(
  runs: ReadonlySet<RunId>,
  event: OrchestrationV2DomainEvent,
): ReadonlySet<RunId> {
  if (event.type !== "run.created" && event.type !== "run.updated") return runs;
  const active = ThreadManagementService.isActiveRun(event.payload);
  if (active === runs.has(event.payload.id)) return runs;
  const next = new Set(runs);
  if (active) next.add(event.payload.id);
  else next.delete(event.payload.id);
  return next;
}

const make = Effect.gen(function* () {
  const statusRef = yield* SubscriptionRef.make<ServerKeepAwakeStatus>({
    active: false,
    error: null,
  });
  const service = KeepAwake.of({ status: SubscriptionRef.changes(statusRef) });
  const command = yield* resolveKeepAwakeCommand(process.pid);
  if (command === null) return service;

  const settingsService = yield* ServerSettings.ServerSettingsService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const layerScope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);

  // Mutated only while holding `lock`.
  let mode: KeepAwakeMode = "off";
  let activeRuns: ReadonlySet<RunId> = new Set();
  let runFollower: Fiber.Fiber<unknown, unknown> | null = null;
  let hold: { readonly scope: Scope.Closeable; readonly startedAtMillis: number } | null = null;
  let releaseTimer: Fiber.Fiber<void> | null = null;
  let failures = 0;
  let error: string | null = null;

  const desired = () => isKeepAwakeDesired(mode, activeRuns.size);
  const publish = Effect.suspend(() =>
    SubscriptionRef.set(statusRef, { active: hold !== null, error }),
  );

  const cancelReleaseTimer = Effect.suspend(() => {
    const timer = releaseTimer;
    releaseTimer = null;
    return timer === null ? Effect.void : Fiber.interrupt(timer);
  });

  const release = Effect.suspend(() => {
    const current = hold;
    hold = null;
    return current === null ? Effect.void : Scope.close(current.scope, Exit.void);
  });

  const acquire: Effect.Effect<void> = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const spawned = yield* spawner
      .spawn(
        ChildProcess.make(command.command, command.args, {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          windowsHide: true,
        }),
      )
      .pipe(Scope.provide(scope), Effect.result);
    if (spawned._tag === "Failure") {
      yield* Scope.close(scope, Exit.void);
      yield* Effect.logWarning("Keep-awake helper failed to start", { cause: spawned.failure });
      return yield* helperFailed("The keep-awake helper could not start.");
    }
    const current = { scope, startedAtMillis: yield* Clock.currentTimeMillis };
    hold = current;
    yield* spawned.success.exitCode.pipe(
      Effect.result,
      Effect.flatMap((exit) => lock.withPermits(1)(onHelperExit(current, exit))),
      Effect.forkIn(layerScope),
    );
  });

  const helperFailed = (message: string): Effect.Effect<void> =>
    Effect.suspend(() => {
      failures += 1;
      if (failures < MAX_HELPER_FAILURES) return acquire;
      error = message;
      return Effect.void;
    });

  const onHelperExit = (
    current: NonNullable<typeof hold>,
    exit: Result.Result<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>,
  ) =>
    Effect.gen(function* () {
      // A release closes the scope, which kills the helper; that exit is expected.
      if (hold !== current) return;
      hold = null;
      yield* Scope.close(current.scope, Exit.void);
      yield* Effect.logWarning("Keep-awake helper exited unexpectedly", {
        exitCode: exit._tag === "Success" ? exit.success : null,
      });
      if (desired()) {
        const uptimeMillis = (yield* Clock.currentTimeMillis) - current.startedAtMillis;
        if (uptimeMillis >= Duration.toMillis(HEALTHY_HELPER_UPTIME)) failures = 0;
        yield* helperFailed("The keep-awake helper stopped unexpectedly.");
      }
      yield* publish;
    });

  const reconcile = Effect.gen(function* () {
    if (desired()) {
      yield* cancelReleaseTimer;
      if (hold === null && error === null) yield* acquire;
    } else if (hold !== null) {
      if (mode === "off") {
        yield* cancelReleaseTimer;
        yield* release;
      } else if (releaseTimer === null) {
        releaseTimer = yield* Effect.sleep(RELEASE_GRACE).pipe(
          Effect.andThen(
            lock.withPermits(1)(
              Effect.gen(function* () {
                releaseTimer = null;
                if (!desired()) yield* release;
                yield* publish;
              }),
            ),
          ),
          Effect.forkIn(layerScope),
        );
      }
    }
    yield* publish;
  });

  const setActiveRuns = (update: (runs: ReadonlySet<RunId>) => ReadonlySet<RunId>) =>
    lock.withPermits(1)(
      Effect.suspend(() => {
        const next = update(activeRuns);
        if (next === activeRuns) return Effect.void;
        activeRuns = next;
        return reconcile;
      }),
    );

  const seedActiveRuns = Effect.gen(function* () {
    const snapshot = yield* threads.getShellSnapshot();
    const projections = yield* Effect.forEach(
      [...snapshot.threads, ...snapshot.archivedThreads].filter(
        (thread) => thread.activityRunStatus != null,
      ),
      (thread) => threads.getThreadProjection(thread.id),
      { concurrency: 4 },
    );
    const runs = new Set(
      projections.flatMap((projection) =>
        projection.runs.filter(ThreadManagementService.isActiveRun).map((run) => run.id),
      ),
    );
    yield* setActiveRuns(() => runs);
    return snapshot.snapshotSequence;
  });

  // Resumes from the last applied event when the bounded stream overflows, so
  // no run transition is skipped.
  const followRuns = (afterSequence: number) => {
    let cursor = afterSequence;
    return Effect.suspend(() =>
      Stream.runForEach(threads.streamStoredEventsFrom({ afterSequence: cursor }), (stored) => {
        cursor = stored.sequence;
        return setActiveRuns((runs) => foldActiveRuns(runs, stored.event));
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Keep-awake run stream failed; resuming", { cause }),
      ),
      Effect.andThen(Effect.sleep("1 second")),
      Effect.forever,
    );
  };

  const followActiveRuns = seedActiveRuns.pipe(
    Effect.tapCause((cause) =>
      Effect.logWarning("Keep-awake could not read active runs; retrying", { cause }),
    ),
    Effect.retry({ schedule: Schedule.spaced("5 seconds") }),
    Effect.flatMap(followRuns),
  );

  // Only the agent mode reads runs, so the default off mode costs no event subscription.
  const stopFollowingRuns = Effect.suspend(() => {
    const follower = runFollower;
    runFollower = null;
    activeRuns = new Set();
    return follower === null ? Effect.void : Fiber.interrupt(follower);
  });

  const setMode = (next: KeepAwakeMode) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (next === mode) return;
        mode = next;
        failures = 0;
        error = null;
        if (next !== "agent") yield* stopFollowingRuns;
        else runFollower ??= yield* Effect.forkIn(followActiveRuns, layerScope);
        yield* reconcile;
      }),
    );

  // Added before the follower fibers so it runs after they are interrupted.
  yield* Effect.addFinalizer(() =>
    lock.withPermits(1)(cancelReleaseTimer.pipe(Effect.andThen(release))),
  );

  const settingsChanges = yield* settingsService.subscribeChanges;
  const initialMode = yield* settingsService.getSettings.pipe(
    Effect.map((settings) => settings.keepAwakeMode),
    Effect.orElseSucceed(() => "off" as const),
  );
  yield* forkParked(
    setMode(initialMode).pipe(
      Effect.andThen(
        Stream.runForEach(settingsChanges, (settings) => setMode(settings.keepAwakeMode)),
      ),
    ),
  );

  return service;
});

export const layer = Layer.effect(KeepAwake, make);
