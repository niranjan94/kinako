import {
  CommandId,
  MessageId,
  type ProjectId,
  WorktreeMcpFailure,
  type WorktreeMcpContinuationStatus,
  type WorktreeMcpHandoffInput,
  type WorktreeMcpHandoffResult,
  type WorktreeMcpStatusResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ThreadWorkspaceService from "../orchestration-v2/ThreadWorkspaceService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { McpInvocationScope, McpThreadInvocationScope } from "./McpInvocationContext.ts";

export class WorktreeMcpService extends Context.Service<
  WorktreeMcpService,
  {
    readonly handoff: (
      scope: McpInvocationScope,
      input: WorktreeMcpHandoffInput,
    ) => Effect.Effect<WorktreeMcpHandoffResult, WorktreeMcpFailure>;
    readonly status: (
      scope: McpInvocationScope,
    ) => Effect.Effect<WorktreeMcpStatusResult, WorktreeMcpFailure>;
  }
>()("t3/mcp/WorktreeMcpService") {}

function failure(code: WorktreeMcpFailure["code"], message: string): WorktreeMcpFailure {
  return new WorktreeMcpFailure({ code, message });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

const asOperationFailed = (prefix: string) =>
  Effect.mapError((error: unknown) =>
    failure("operation_failed", `${prefix}: ${errorMessage(error)}`),
  );

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const workspace = yield* ThreadWorkspaceService.ThreadWorkspaceService;

  const requireThreadScope = (scope: McpInvocationScope) =>
    scope.thread === undefined
      ? Effect.fail(
          failure(
            "thread_credential_required",
            "Worktree handoff and status act as the calling T3 thread, so they need an agent running inside T3 Code.",
          ),
        )
      : Effect.succeed(scope as McpThreadInvocationScope);

  const requireCapability = (scope: McpInvocationScope) =>
    scope.capabilities.has("worktree")
      ? Effect.void
      : Effect.fail(
          failure("capability_denied", "This MCP credential does not grant worktree capabilities."),
        );

  const loadThread = (scope: McpThreadInvocationScope) =>
    threadManagement.getThreadRecords(scope.thread.threadId, []).pipe(
      Effect.mapError((error) =>
        error._tag === "OrchestratorProjectionError"
          ? failure("thread_not_found", `Thread '${scope.thread.threadId}' was not found.`)
          : failure(
              "operation_failed",
              `Unable to read thread ${scope.thread.threadId}: ${errorMessage(error)}`,
            ),
      ),
      Effect.filterOrFail(
        (projection) => projection.thread.deletedAt === null,
        () => failure("thread_not_found", `Thread '${scope.thread.threadId}' was not found.`),
      ),
    );

  const loadProject = (scope: McpThreadInvocationScope, projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      asOperationFailed(`Unable to read project ${projectId}`),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              failure(
                "project_not_found",
                `Project '${projectId}' was not found for thread '${scope.thread.threadId}'.`,
              ),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  const readDefaultStartFromOrigin = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.newWorktreesStartFromOrigin),
    asOperationFailed("Unable to read server settings"),
  );

  const handoffIds = (scope: McpThreadInvocationScope) =>
    crypto.randomUUIDv4().pipe(
      Effect.map((uuid) => {
        const part = (kind: string, operation: string) =>
          [kind, "mcp", encodeURIComponent(scope.thread.providerSessionId), operation, uuid].join(
            ":",
          );
        return {
          commandId: CommandId.make(part("command", "worktree-handoff")),
          continuationCommandId: CommandId.make(part("command", "worktree-continuation")),
          continuationMessageId: MessageId.make(part("message", "worktree-continuation")),
        };
      }),
      Effect.orDie,
    );

  const handoff: WorktreeMcpService["Service"]["handoff"] = Effect.fn("WorktreeMcpService.handoff")(
    function* (callerScope, input) {
      yield* requireCapability(callerScope);
      const scope = yield* requireThreadScope(callerScope);
      const projection = yield* loadThread(scope);
      const project = yield* loadProject(scope, projection.thread.projectId);
      let baseRef = input.baseRef;
      const startFromOrigin = input.startFromOrigin ?? (yield* readDefaultStartFromOrigin);
      let startedFromOrigin = false;
      if (input.target !== "local" && startFromOrigin && input.branch !== undefined) {
        const localBaseRef =
          baseRef ??
          (yield* gitWorkflow
            .localStatus({ cwd: project.workspaceRoot })
            .pipe(asOperationFailed("Unable to read git status"))).refName ??
          "HEAD";
        const resolvedRemoteBase = yield* gitWorkflow
          .fetchWorktreeBaseCommit({ cwd: project.workspaceRoot, refName: localBaseRef })
          .pipe(asOperationFailed(`Unable to fetch the remote base of '${localBaseRef}'`));
        if (resolvedRemoteBase !== null) {
          baseRef = resolvedRemoteBase.commitSha;
          startedFromOrigin = true;
        }
      }
      const result = yield* workspace
        .moveThread({
          threadId: scope.thread.threadId,
          expectedWorktreePath:
            input.expectedWorktreePath === undefined
              ? projection.thread.worktreePath
              : input.expectedWorktreePath,
          target:
            input.target === "local"
              ? "local"
              : {
                  worktree:
                    input.branch === undefined
                      ? "associated"
                      : { branch: input.branch, ...(baseRef === undefined ? {} : { baseRef }) },
                },
          runSetupScript: input.runSetupScript ?? true,
        })
        .pipe(Effect.mapError((error) => failure("operation_failed", error.message)));
      let continuation: WorktreeMcpContinuationStatus = { status: "skipped" };
      if (input.continuationPrompt !== undefined) {
        const ids = yield* handoffIds(scope);
        continuation = yield* threadManagement
          .sendToThread({
            projectId: project.id,
            commandId: ids.continuationCommandId,
            threadId: scope.thread.threadId,
            messageId: ids.continuationMessageId,
            text: input.continuationPrompt,
            attachments: [],
            mode: "queue",
            createdBy: "agent",
            creationSource: "mcp",
          })
          .pipe(
            Effect.map((sent): WorktreeMcpContinuationStatus => ({
              status: "scheduled",
              delivery: sent.delivery,
            })),
            Effect.orElseSucceed((): WorktreeMcpContinuationStatus => ({
              status: "failed",
              detail: "Could not queue the continuation.",
            })),
          );
      }
      return {
        worktreePath: result.worktreePath,
        branch: result.branch,
        baseRef: input.baseRef ?? projection.thread.branch ?? "HEAD",
        startedFromOrigin,
        setupScript: result.setupScript,
        continuation,
        note: result.cleanupPending
          ? "Workspace moved. Source changes were preserved because cleanup could not finish; retry with the same expectedWorktreePath to finish cleanup."
          : "Workspace moved with uncommitted changes. The conversation continues at the new cwd on the next turn. The associated worktree is retained when moving to local.",
      };
    },
  );

  const status: WorktreeMcpService["Service"]["status"] = Effect.fn("WorktreeMcpService.status")(
    function* (callerScope) {
      yield* requireCapability(callerScope);
      const scope = yield* requireThreadScope(callerScope);
      const projection = yield* loadThread(scope);
      const project = yield* loadProject(scope, projection.thread.projectId);

      const defaultStartFromOrigin = yield* readDefaultStartFromOrigin;

      const result: WorktreeMcpStatusResult = {
        attached: projection.thread.worktreePath !== null,
        worktreePath: projection.thread.worktreePath,
        branch: projection.thread.branch,
        projectWorkspaceRoot: project.workspaceRoot,
        defaultStartFromOrigin,
      };
      return result;
    },
  );

  return WorktreeMcpService.of({ handoff, status });
});

export const layer = Layer.effect(WorktreeMcpService, make);
