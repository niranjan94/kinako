import {
  CommandId,
  FollowUpError,
  type ProjectId,
  type ThreadId,
  type FollowUpSetDismissedInput,
  type FollowUpStartInput,
  type FollowUpStartResult,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as ServerSettings from "../serverSettings.ts";

type FollowUpItem = Extract<OrchestrationV2TurnItem, { readonly type: "follow_up" }>;

export class FollowUpService extends Context.Service<
  FollowUpService,
  {
    readonly start: (
      input: FollowUpStartInput,
    ) => Effect.Effect<FollowUpStartResult, FollowUpError>;
    readonly setDismissed: (input: FollowUpSetDismissedInput) => Effect.Effect<void, FollowUpError>;
  }
>()("t3/followUps/FollowUpService") {}

const make = Effect.gen(function* () {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  const projectFiles = yield* T3ProjectFileLoader.T3ProjectFileLoader;

  // The suggesting thread lives in this project, so the new-project-folder
  // exception in resolveNewThreadEnvMode never applies; the setting is the answer.
  const defaultEnvMode = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings;
      const project = Option.getOrUndefined(yield* projects.getById(projectId));
      const resolved = resolveProjectSettings(settings, projectId, project).settings;
      if (resolved.defaultThreadEnvMode !== null || project === undefined) {
        return resolved.defaultThreadEnvMode ?? "local";
      }
      const projectFile = yield* projectFiles.load(project.workspaceRoot);
      return resolveProjectSettings(settings, projectId, project, Option.getOrNull(projectFile))
        .settings.defaultThreadEnvMode;
    }).pipe(Effect.mapError((cause) => new FollowUpError({ reason: "load_failed", cause })));
  // Load, launch, and record are separate steps, so two clients starting the
  // same card at once would otherwise both see it suggested and launch twice.
  const startLock = yield* Semaphore.make(1);

  const load = (threadId: ThreadId, turnItemId: string) =>
    Effect.gen(function* () {
      const records = yield* threadManagement
        .getThreadRecords(threadId, ["turnItems"], {
          turnItemTypes: ["follow_up"],
          messageRoles: [],
        })
        .pipe(Effect.mapError((cause) => new FollowUpError({ reason: "load_failed", cause })));
      const item = records.turnItems.find((candidate) => candidate.id === turnItemId);
      if (item?.type !== "follow_up" || item.runId === null || item.nodeId === null) {
        return yield* new FollowUpError({ reason: "not_found" });
      }
      return { thread: records.thread, item, runId: item.runId, nodeId: item.nodeId };
    });

  const record = (
    loaded: Effect.Success<ReturnType<typeof load>>,
    followUpStatus: FollowUpItem["followUpStatus"],
    commandId: CommandId,
    startedThreadId?: ThreadId,
  ) =>
    threadManagement
      .dispatch({
        type: "follow_up.record",
        commandId,
        threadId: loaded.thread.id,
        runId: loaded.runId,
        nodeId: loaded.nodeId,
        turnItemId: loaded.item.id,
        label: loaded.item.label,
        prompt: loaded.item.prompt,
        followUpStatus,
        ...(startedThreadId === undefined ? {} : { startedThreadId }),
      })
      .pipe(Effect.mapError((cause) => new FollowUpError({ reason: "record_failed", cause })));

  const start: FollowUpService["Service"]["start"] = (input) =>
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.thread_id": input.threadId,
        "follow_up.workspace": input.workspace ?? "default",
      });
      const loaded = yield* load(input.threadId, input.turnItemId);
      const { thread, item } = loaded;
      if (item.followUpStatus === "started" && item.startedThreadId !== undefined) {
        return { threadId: item.startedThreadId };
      }
      const branch = thread.branch ?? undefined;
      // Without a branch there is nothing to base a worktree on, so the
      // default quietly stays in the current checkout; an explicit request fails.
      const workspace =
        input.workspace ??
        ((yield* defaultEnvMode(thread.projectId)) === "worktree" && branch !== undefined
          ? "worktree"
          : "current");
      yield* Effect.annotateCurrentSpan({ "follow_up.resolved_workspace": workspace });
      let workspaceStrategy: ThreadLaunch.ThreadLaunchWorkspaceStrategy;
      if (workspace === "worktree") {
        if (branch === undefined) return yield* new FollowUpError({ reason: "no_base_branch" });
        workspaceStrategy = { type: "worktree", baseRef: branch };
        yield* launches
          .checkWorktreeBase({ projectId: thread.projectId, workspaceStrategy })
          .pipe(
            Effect.mapError(
              (cause) =>
                new FollowUpError({ reason: "launch_failed", detail: cause.message, cause }),
            ),
          );
      } else {
        workspaceStrategy =
          thread.worktreePath === null
            ? { type: "root", branch }
            : { type: "existing_worktree", worktreePath: thread.worktreePath, branch };
      }
      // A fresh id per attempt: a launch the server rejected must stay retryable.
      const commandId = CommandId.make(`follow-up:${yield* randomUuidV4}`);
      // A client disconnect interrupts this handler; stopping between launch
      // and record would leave the card suggested and a retry would launch again.
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const launched = yield* launches
            .launch({
              commandId,
              projectId: thread.projectId,
              title: item.label,
              modelSelection: thread.modelSelection,
              runtimeMode: thread.runtimeMode,
              interactionMode: "default",
              workspaceStrategy,
              initialMessage: { text: item.prompt, attachments: [] },
              createdBy: "user",
              creationSource: "server",
            })
            .pipe(
              Effect.mapError((cause) =>
                cause._tag === "ThreadManagementProviderInstanceDisabledError"
                  ? new FollowUpError({ reason: "launch_failed", detail: cause.message, cause })
                  : new FollowUpError({ reason: "launch_failed", cause }),
              ),
            );
          yield* record(
            loaded,
            "started",
            CommandId.make(`${commandId}:recorded`),
            launched.threadId,
          );
          return { threadId: launched.threadId };
        }),
      );
    }).pipe(startLock.withPermits(1), Effect.withSpan("FollowUpService.start"));

  const setDismissed: FollowUpService["Service"]["setDismissed"] = (input) =>
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.thread_id": input.threadId,
        "follow_up.dismissed": input.dismissed,
      });
      const loaded = yield* load(input.threadId, input.turnItemId);
      if (loaded.item.followUpStatus === "started") {
        return yield* new FollowUpError({ reason: "already_started" });
      }
      const followUpStatus = input.dismissed ? "dismissed" : "suggested";
      if (loaded.item.followUpStatus === followUpStatus) return;
      yield* record(
        loaded,
        followUpStatus,
        CommandId.make(`follow-up:${yield* randomUuidV4}:${followUpStatus}`),
      );
    }).pipe(Effect.withSpan("FollowUpService.setDismissed"));

  return FollowUpService.of({ start, setDismissed });
});

export const layer = Layer.effect(FollowUpService, make);
