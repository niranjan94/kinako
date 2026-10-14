import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type KeepAwakeMode,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadShellSnapshot,
  RunId,
  type ServerKeepAwakeStatus,
  type ServerSettings as ServerSettingsValue,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as KeepAwake from "./KeepAwake.ts";

interface Helper {
  readonly command: string;
  readonly exit: Deferred.Deferred<ChildProcessSpawner.ExitCode>;
  killedAtMillis: number | null;
}

const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");

function runEvent(
  sequence: number,
  run: {
    readonly id: string;
    readonly threadId: ThreadId;
    readonly status: OrchestrationV2Run["status"];
  },
): OrchestrationV2StoredEvent {
  // Only the fields the keep-awake fold reads are meaningful here.
  return {
    sequence,
    commandId: null,
    event: {
      type: "run.updated",
      threadId: run.threadId,
      payload: { ...run, id: RunId.make(run.id) },
    },
  } as unknown as OrchestrationV2StoredEvent;
}

const makeHarness = Effect.fn(function* (input: {
  readonly mode: KeepAwakeMode;
  readonly activeAtStartup?: ReadonlyArray<{ readonly id: string; readonly threadId: ThreadId }>;
}) {
  let settings: ServerSettingsValue = { ...DEFAULT_SERVER_SETTINGS, keepAwakeMode: input.mode };
  const settingsChanges = yield* PubSub.unbounded<ServerSettingsValue>();
  const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
  const spawned = yield* Queue.unbounded<Helper>();
  const helpers: Array<Helper> = [];

  const seededRuns = input.activeAtStartup ?? [];
  const shellSnapshot = {
    schemaVersion: 1,
    snapshotSequence: 0,
    threads: [...new Set(seededRuns.map((run) => run.threadId))].map(
      (id) => ({ id, activityRunStatus: "running" }) as unknown as OrchestrationV2ThreadShell,
    ),
    archivedThreads: [],
  } as unknown as OrchestrationV2ThreadShellSnapshot;

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.acquireRelease(
      Effect.gen(function* () {
        const helper: Helper = {
          command: (command as unknown as { readonly command: string }).command,
          exit: yield* Deferred.make<ChildProcessSpawner.ExitCode>(),
          killedAtMillis: null,
        };
        helpers.push(helper);
        yield* Queue.offer(spawned, helper);
        return helper;
      }),
      (helper) =>
        Effect.gen(function* () {
          if (yield* Deferred.isDone(helper.exit)) return;
          helper.killedAtMillis = yield* Clock.currentTimeMillis;
          yield* Deferred.succeed(helper.exit, ChildProcessSpawner.ExitCode(143));
        }),
    ).pipe(
      Effect.map((helper) =>
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(helpers.length),
          exitCode: Deferred.await(helper.exit),
          isRunning: Deferred.isDone(helper.exit).pipe(Effect.map((done) => !done)),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    ),
  );

  const layer = KeepAwake.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.sync(() => settings),
          subscribeChanges: PubSub.subscribe(settingsChanges).pipe(
            Effect.map((subscription) => Stream.fromSubscription(subscription)),
          ),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getShellSnapshot: () => Effect.succeed(shellSnapshot),
          getThreadProjection: (threadId) =>
            Effect.succeed({
              runs: seededRuns
                .filter((run) => run.threadId === threadId)
                .map((run) => ({ ...run, id: RunId.make(run.id), status: "running" })),
            } as unknown as OrchestrationV2ThreadProjection),
          streamStoredEventsFrom: () => Stream.fromQueue(events),
        }),
      ),
    ),
  );

  const scope = yield* Scope.make();
  const context = yield* Layer.buildWithScope(layer, scope).pipe(
    Effect.provideService(HostProcess.Platform, "darwin"),
  );
  const statuses = yield* Queue.unbounded<ServerKeepAwakeStatus>();
  const subscribed = yield* Deferred.make<void>();
  yield* Context.get(context, KeepAwake.KeepAwake).status.pipe(
    Stream.runForEach((status) =>
      Deferred.succeed(subscribed, undefined).pipe(Effect.andThen(Queue.offer(statuses, status))),
    ),
    Effect.forkIn(scope),
  );
  yield* Deferred.await(subscribed);

  const untilStatus = (predicate: (status: ServerKeepAwakeStatus) => boolean) =>
    Queue.take(statuses).pipe(Effect.repeat({ until: predicate }));

  return {
    helpers,
    nextHelper: Queue.take(spawned),
    // Every applied change publishes one status, so this waits for the next change to land.
    nextStatus: Queue.take(statuses),
    untilStatus,
    emit: (event: OrchestrationV2StoredEvent) => Queue.offer(events, event),
    setMode: (mode: KeepAwakeMode) => {
      settings = { ...settings, keepAwakeMode: mode };
      return PubSub.publish(settingsChanges, settings);
    },
    shutdown: Scope.close(scope, Exit.void),
  };
});

describe("KeepAwake", () => {
  it.effect("holds while a run is active and releases after the grace period", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ mode: "agent" });
      // A run blocked on an approval counts: the user may answer from another device.
      yield* harness.emit(runEvent(1, { id: "run-1", threadId: threadA, status: "waiting" }));
      const helper = yield* harness.nextHelper;
      assert.equal(helper.command, "/usr/bin/caffeinate");
      yield* harness.untilStatus((status) => status.active);

      yield* harness.emit(runEvent(2, { id: "run-1", threadId: threadA, status: "completed" }));
      assert.deepEqual(yield* harness.nextStatus, { active: true, error: null });
      yield* TestClock.adjust("29 seconds");
      assert.equal(helper.killedAtMillis, null);

      yield* TestClock.adjust("1 second");
      yield* harness.untilStatus((status) => !status.active);
      assert.equal(helper.killedAtMillis, 30_000);
      assert.equal(harness.helpers.length, 1);
      yield* harness.shutdown;
    }),
  );

  it.effect("keeps one helper across back-to-back runs inside the grace period", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ mode: "agent" });
      yield* harness.emit(runEvent(1, { id: "run-1", threadId: threadA, status: "running" }));
      yield* harness.untilStatus((status) => status.active);
      yield* harness.emit(runEvent(2, { id: "run-1", threadId: threadA, status: "completed" }));
      yield* harness.nextStatus;
      yield* TestClock.adjust("10 seconds");
      yield* harness.emit(runEvent(3, { id: "run-2", threadId: threadB, status: "preparing" }));
      yield* harness.nextStatus;
      yield* TestClock.adjust("1 minute");

      assert.equal(harness.helpers.length, 1);
      assert.equal(harness.helpers[0]?.killedAtMillis, null);
      yield* harness.shutdown;
    }),
  );

  it.effect("holds for runs already active at startup until they finish", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        mode: "agent",
        activeAtStartup: [{ id: "run-1", threadId: threadA }],
      });
      const helper = yield* harness.nextHelper;
      yield* harness.untilStatus((status) => status.active);

      yield* harness.emit(runEvent(1, { id: "run-1", threadId: threadA, status: "interrupted" }));
      yield* harness.nextStatus;
      yield* TestClock.adjust("30 seconds");
      yield* harness.untilStatus((status) => !status.active);
      assert.equal(helper.killedAtMillis, 30_000);
      yield* harness.shutdown;
    }),
  );

  it.effect("holds without runs in always mode and releases at once when turned off", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ mode: "always" });
      const helper = yield* harness.nextHelper;
      yield* harness.untilStatus((status) => status.active);

      yield* harness.setMode("off");
      yield* harness.untilStatus((status) => !status.active);
      assert.equal(helper.killedAtMillis, 0);
      yield* harness.shutdown;
    }),
  );

  it.effect("restarts a helper that dies once, then reports the error until the mode changes", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ mode: "always" });
      const first = yield* harness.nextHelper;
      yield* Deferred.succeed(first.exit, ChildProcessSpawner.ExitCode(1));
      const second = yield* harness.nextHelper;
      yield* Deferred.succeed(second.exit, ChildProcessSpawner.ExitCode(1));
      const failed = yield* harness.untilStatus((status) => status.error !== null);
      assert.equal(failed.active, false);
      assert.equal(harness.helpers.length, 2);

      yield* harness.setMode("agent");
      yield* harness.setMode("always");
      yield* harness.nextHelper;
      yield* harness.untilStatus((status) => status.active && status.error === null);
      yield* harness.shutdown;
    }),
  );

  it.effect("restarts a helper again when it dies after running healthily", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ mode: "always" });
      const first = yield* harness.nextHelper;
      yield* TestClock.adjust("2 minutes");
      yield* Deferred.succeed(first.exit, ChildProcessSpawner.ExitCode(1));
      const second = yield* harness.nextHelper;
      yield* TestClock.adjust("2 minutes");
      yield* Deferred.succeed(second.exit, ChildProcessSpawner.ExitCode(1));
      yield* harness.nextHelper;
      yield* harness.untilStatus((status) => status.active);
      assert.equal(harness.helpers.length, 3);
      yield* harness.shutdown;
    }),
  );

  it.effect("has no helper inside WSL, where logind cannot hold the Windows host awake", () =>
    Effect.gen(function* () {
      const command = yield* KeepAwake.resolveKeepAwakeCommand(1).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Environment, { WSL_DISTRO_NAME: "Ubuntu" }),
        Effect.provide(NodeServices.layer),
      );
      assert.equal(command, null);
    }),
  );

  it.effect("releases the helper when the server shuts down", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ mode: "always" });
      const helper = yield* harness.nextHelper;
      yield* harness.untilStatus((status) => status.active);

      yield* harness.shutdown;
      assert.equal(helper.killedAtMillis, 0);
    }),
  );
});
