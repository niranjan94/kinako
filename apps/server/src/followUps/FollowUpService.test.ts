import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as FollowUpService from "./FollowUpService.ts";

const threadId = ThreadId.make("thread-source");
const turnItemId = TurnItemId.make("turn-item:follow-up:1");
const projectId = ProjectId.make("project-1");
const modelSelection = { instanceId: "codex", model: "gpt-5" };

const withService = <A, E>(
  body: (input: {
    readonly service: FollowUpService.FollowUpService["Service"];
    readonly dispatched: Array<OrchestrationV2ServerCommand>;
    readonly launched: Array<ThreadLaunch.ThreadLaunchInput>;
  }) => Effect.Effect<A, E>,
  options: {
    readonly followUpStatus?: "suggested" | "started" | "dismissed";
    readonly startedThreadId?: ThreadId;
    readonly branch?: string | null;
    readonly worktreePath?: string | null;
    readonly defaultThreadEnvMode?: "local" | "worktree" | null;
    readonly projectFileEnvMode?: "local" | "worktree";
  } = {},
) =>
  Effect.gen(function* () {
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const layer = FollowUpService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: () =>
              Effect.succeed({
                thread: {
                  id: threadId,
                  projectId,
                  modelSelection,
                  runtimeMode: "full-access",
                  branch: options.branch === undefined ? "feature/source" : options.branch,
                  worktreePath:
                    options.worktreePath === undefined
                      ? "/repo/.worktrees/source"
                      : options.worktreePath,
                },
                turnItems: [
                  {
                    id: turnItemId,
                    threadId,
                    runId: "run-1",
                    nodeId: "node-root",
                    type: "follow_up",
                    label: "Add retry tests",
                    prompt: "Write tests for the retry queue in src/retry.ts.",
                    followUpStatus: options.followUpStatus ?? "suggested",
                    ...(options.startedThreadId === undefined
                      ? {}
                      : { startedThreadId: options.startedThreadId }),
                  },
                ],
              } as never),
            dispatch: (command) =>
              Effect.sync(() => {
                dispatched.push(command);
                return {} as never;
              }),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              defaultThreadEnvMode: options.defaultThreadEnvMode ?? null,
            }),
          }),
          Layer.mock(ProjectService.ProjectService)({
            getById: () =>
              Effect.succeed(Option.some({ id: projectId, workspaceRoot: "/repo" } as never)),
          }),
          Layer.mock(T3ProjectFileLoader.T3ProjectFileLoader)({
            load: () =>
              Effect.succeed(
                options.projectFileEnvMode === undefined
                  ? Option.none()
                  : Option.some({ defaultThreadEnvMode: options.projectFileEnvMode } as never),
              ),
          }),
          Layer.mock(ThreadLaunch.ThreadLaunchService)({
            checkWorktreeBase: () => Effect.void,
            launch: (input) =>
              Effect.sync(() => {
                launched.push(input);
                return {
                  threadId: ThreadId.make(`thread-launched-${launched.length}`),
                  projection: {} as never,
                  resumed: false,
                };
              }),
          }),
        ),
      ),
    );
    const service = yield* FollowUpService.FollowUpService.pipe(Effect.provide(layer));
    return yield* body({ service, dispatched, launched });
  });

it.effect("starts a follow-up in the suggesting thread's checkout and records the new thread", () =>
  withService(({ service, dispatched, launched }) =>
    Effect.gen(function* () {
      const result = yield* service.start({ threadId, turnItemId, workspace: "current" });
      assert.strictEqual(launched.length, 1);
      const launch = launched[0]!;
      assert.deepStrictEqual(launch.workspaceStrategy, {
        type: "existing_worktree",
        worktreePath: "/repo/.worktrees/source",
        branch: "feature/source",
      });
      assert.strictEqual(launch.title, "Add retry tests");
      assert.strictEqual(
        launch.initialMessage?.text,
        "Write tests for the retry queue in src/retry.ts.",
      );
      assert.deepStrictEqual(launch.modelSelection, modelSelection);
      assert.strictEqual(launch.runtimeMode, "full-access");
      assert.strictEqual(launch.createdBy, "user");
      assert.strictEqual(result.threadId, ThreadId.make("thread-launched-1"));
      assert.deepStrictEqual(
        dispatched.map((command) =>
          command.type === "follow_up.record"
            ? { status: command.followUpStatus, startedThreadId: command.startedThreadId }
            : command.type,
        ),
        [{ status: "started", startedThreadId: result.threadId }],
      );
    }),
  ),
);

it.effect("starts a follow-up in a new worktree branched from the suggesting thread", () =>
  withService(
    ({ service, launched }) =>
      Effect.gen(function* () {
        yield* service.start({ threadId, turnItemId, workspace: "worktree" });
        assert.deepStrictEqual(launched[0]?.workspaceStrategy, {
          type: "worktree",
          baseRef: "feature/source",
        });
      }),
    { worktreePath: null },
  ),
);

it.effect("refuses a new worktree when the thread has no branch to base it on", () =>
  withService(
    ({ service, launched, dispatched }) =>
      Effect.gen(function* () {
        const error = yield* service
          .start({ threadId, turnItemId, workspace: "worktree" })
          .pipe(Effect.flip);
        assert.strictEqual(error.reason, "no_base_branch");
        assert.strictEqual(launched.length, 0);
        assert.strictEqual(dispatched.length, 0);
      }),
    { branch: null, worktreePath: null },
  ),
);

it.effect("returns the existing thread for a follow-up that was already started", () =>
  withService(
    ({ service, launched, dispatched }) =>
      Effect.gen(function* () {
        const result = yield* service.start({ threadId, turnItemId, workspace: "current" });
        assert.strictEqual(result.threadId, ThreadId.make("thread-started"));
        assert.strictEqual(launched.length, 0);
        assert.strictEqual(dispatched.length, 0);
      }),
    { followUpStatus: "started", startedThreadId: ThreadId.make("thread-started") },
  ),
);

it.effect("dismisses and restores a follow-up, but not one that was started", () =>
  Effect.gen(function* () {
    yield* withService(({ service, dispatched }) =>
      Effect.gen(function* () {
        yield* service.setDismissed({ threadId, turnItemId, dismissed: true });
        yield* service.setDismissed({ threadId, turnItemId, dismissed: false });
        assert.deepStrictEqual(
          dispatched.map((command) =>
            command.type === "follow_up.record" ? command.followUpStatus : command.type,
          ),
          ["dismissed"],
        );
      }),
    );
    yield* withService(
      ({ service, dispatched }) =>
        Effect.gen(function* () {
          yield* service.setDismissed({ threadId, turnItemId, dismissed: false });
          assert.deepStrictEqual(
            dispatched.map((command) =>
              command.type === "follow_up.record" ? command.followUpStatus : command.type,
            ),
            ["suggested"],
          );
        }),
      { followUpStatus: "dismissed" },
    );
    yield* withService(
      ({ service }) =>
        Effect.gen(function* () {
          const error = yield* service
            .setDismissed({ threadId, turnItemId, dismissed: true })
            .pipe(Effect.flip);
          assert.strictEqual(error.reason, "already_started");
        }),
      { followUpStatus: "started", startedThreadId: ThreadId.make("thread-started") },
    );
  }),
);

it.effect("follows the project's default for new threads when no workspace is chosen", () =>
  Effect.gen(function* () {
    const strategyFor = (options: Parameters<typeof withService>[1]) =>
      withService(
        ({ service, launched }) =>
          Effect.gen(function* () {
            yield* service.start({ threadId, turnItemId });
            return launched[0]?.workspaceStrategy.type;
          }),
        options,
      );
    assert.strictEqual(yield* strategyFor({ defaultThreadEnvMode: "worktree" }), "worktree");
    assert.strictEqual(yield* strategyFor({ defaultThreadEnvMode: "local" }), "existing_worktree");
    assert.strictEqual(yield* strategyFor({ projectFileEnvMode: "worktree" }), "worktree");
    assert.strictEqual(yield* strategyFor({}), "existing_worktree");
    assert.strictEqual(
      yield* strategyFor({ defaultThreadEnvMode: "worktree", branch: null, worktreePath: null }),
      "root",
    );
  }),
);
