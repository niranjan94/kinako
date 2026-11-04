import { describe, expect, it, vi } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ThreadWorkspaceError,
  type OrchestrationV2ThreadProjection,
  type Project,
  type VcsMoveThreadInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadWorkspaceService from "../orchestration-v2/ThreadWorkspaceService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as WorktreeMcpService from "./WorktreeMcpService.ts";

const threadId = ThreadId.make("thread-worktree-test");
const projectId = ProjectId.make("project-worktree-test");
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("worktree-test"),
  requestNamespace: "worktree-test",
  thread: {
    threadId,
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["worktree"]),
  issuedAt: 1,
};

function harness(
  worktreePath: string | null = null,
  fails = false,
  projectStartFromOrigin?: boolean,
) {
  const moveThread = vi.fn((input: VcsMoveThreadInput) =>
    fails
      ? Effect.fail(new ThreadWorkspaceError({ reason: "active_run" }))
      : Effect.succeed({
          branch: "feature/move",
          worktreePath: input.target === "local" ? null : "/repo/worktree",
          conflicts: false,
          cleanupPending: false,
          setupScript: { status: "no-script" as const },
        }),
  );
  const sendToThread = vi.fn(() => Effect.succeed({ delivery: "queued" }));
  const fetchWorktreeBaseCommit = vi.fn((_input: { cwd: string; refName: string }) =>
    Effect.succeed<{ commitSha: string; remoteRefName: string } | null>({
      commitSha: "abc123",
      remoteRefName: "upstream/main",
    }),
  );
  const listRefs = vi.fn((_input: { readonly cwd: string }) =>
    Effect.succeed({ refs: [], isRepo: true, hasPrimaryRemote: false }),
  );
  const layer = WorktreeMcpService.layer.pipe(
    Layer.provide(Layer.succeed(ThreadWorkspaceService.ThreadWorkspaceService, { moveThread })),
    Layer.provide(
      Layer.succeed(ThreadManagementService.ThreadManagementService, {
        getThreadRecords: () =>
          Effect.succeed({
            thread: {
              id: threadId,
              projectId,
              worktreePath,
              branch: "feature/move",
              deletedAt: null,
            },
          } as unknown as OrchestrationV2ThreadProjection),
        sendToThread,
      } as unknown as ThreadManagementService.ThreadManagementService["Service"]),
    ),
    Layer.provide(
      Layer.succeed(ProjectService.ProjectService, {
        getById: () =>
          Effect.succeedSome({
            id: projectId,
            workspaceRoot: "/repo",
            scripts: [],
          } as unknown as Project),
      } as unknown as ProjectService.ProjectService["Service"]),
    ),
    Layer.provide(
      ServerSettings.layerTest({
        newWorktreesStartFromOrigin: false,
        ...(projectStartFromOrigin === undefined
          ? {}
          : {
              projectSettingsOverrides: {
                [projectId]: { newWorktreesStartFromOrigin: projectStartFromOrigin },
              },
            }),
      }),
    ),
    Layer.provide(
      Layer.succeed(GitWorkflowService.GitWorkflowService, {
        fetchWorktreeBaseCommit,
        listRefs,
        localStatus: () => Effect.succeed({ refName: "main" }),
      } as unknown as GitWorkflowService.GitWorkflowService["Service"]),
    ),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  return { layer, moveThread, sendToThread, fetchWorktreeBaseCommit, listRefs };
}

describe("WorktreeMcpService", () => {
  it.effect(
    "moves to a worktree through the shared service and queues continuation only after success",
    () => {
      const h = harness();
      return Effect.gen(function* () {
        const service = yield* WorktreeMcpService.WorktreeMcpService;
        const result = yield* service.handoff(scope, {
          branch: "feature/move",
          continuationPrompt: "Continue",
        });
        expect(h.moveThread).toHaveBeenCalledWith({
          threadId,
          expectedWorktreePath: null,
          target: { worktree: { branch: "feature/move" } },
          runSetupScript: true,
        });
        expect(result.worktreePath).toBe("/repo/worktree");
        expect(result.continuation.status).toBe("scheduled");
        expect(h.sendToThread).toHaveBeenCalledOnce();
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.effect("starts a new worktree branch from the base ref's own remote when asked", () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* WorktreeMcpService.WorktreeMcpService;
      const result = yield* service.handoff(scope, {
        branch: "feature/move",
        baseRef: "main",
        startFromOrigin: true,
      });
      expect(h.fetchWorktreeBaseCommit).toHaveBeenCalledWith({ cwd: "/repo", refName: "main" });
      expect(h.moveThread.mock.calls[0]?.[0].target).toEqual({
        worktree: { branch: "feature/move", baseRef: "abc123" },
      });
      expect(result.startedFromOrigin).toBe(true);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("defaults startFromOrigin to the project's override", () => {
    const h = harness(null, false, true);
    return Effect.gen(function* () {
      const service = yield* WorktreeMcpService.WorktreeMcpService;
      const result = yield* service.handoff(scope, { branch: "feature/project-origin" });
      expect(h.fetchWorktreeBaseCommit).toHaveBeenCalledWith({ cwd: "/repo", refName: "main" });
      expect(result.startedFromOrigin).toBe(true);
      expect((yield* service.status(scope)).defaultStartFromOrigin).toBe(true);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("moves back to local and retains the original source for cleanup retries", () => {
    const h = harness("/repo/worktree");
    return Effect.gen(function* () {
      const service = yield* WorktreeMcpService.WorktreeMcpService;
      const result = yield* service.handoff(scope, {
        target: "local",
        expectedWorktreePath: "/repo/worktree",
      });
      expect(h.moveThread).toHaveBeenCalledWith({
        threadId,
        expectedWorktreePath: "/repo/worktree",
        target: "local",
        runSetupScript: true,
      });
      expect(result.worktreePath).toBe(null);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("reuses the associated worktree when branch is omitted", () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* WorktreeMcpService.WorktreeMcpService;
      yield* service.handoff(scope, {});
      expect(h.moveThread.mock.calls[0]?.[0].target).toEqual({ worktree: "associated" });
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("propagates move rejection without queuing a continuation", () => {
    const h = harness(null, true);
    return Effect.gen(function* () {
      const service = yield* WorktreeMcpService.WorktreeMcpService;
      expect(
        (yield* service
          .handoff(scope, { branch: "feature/move", continuationPrompt: "Continue" })
          .pipe(Effect.flip)).message,
      ).toContain("active run");
      expect(h.sendToThread).not.toHaveBeenCalled();
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("requires worktree capability and a thread credential", () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* WorktreeMcpService.WorktreeMcpService;
      expect(
        (yield* service.handoff({ ...scope, capabilities: new Set() }, {}).pipe(Effect.flip)).code,
      ).toBe("capability_denied");
      expect(
        (yield* service.handoff({ ...scope, thread: undefined }, {}).pipe(Effect.flip)).code,
      ).toBe("thread_credential_required");
      expect(h.moveThread).not.toHaveBeenCalled();
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("reports the current binding", () => {
    const h = harness("/repo/worktree");
    return Effect.gen(function* () {
      const service = yield* WorktreeMcpService.WorktreeMcpService;
      expect(yield* service.status(scope)).toMatchObject({
        attached: true,
        worktreePath: "/repo/worktree",
        projectWorkspaceRoot: "/repo",
      });
    }).pipe(Effect.provide(h.layer));
  });

  it.effect(
    "lists refs from the thread's worktree, or the project root once it was removed",
    () => {
      const h = harness();
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const worktreePath = yield* fs.makeTempDirectoryScoped({ prefix: "worktree-list-" });
        const service = yield* WorktreeMcpService.WorktreeMcpService;
        yield* service.listRefs({ worktreePath, workspaceRoot: "/repo" });
        yield* service.listRefs({
          worktreePath: `${worktreePath}/removed`,
          workspaceRoot: "/repo",
        });
        expect(h.listRefs.mock.calls.map(([input]) => input.cwd)).toEqual([worktreePath, "/repo"]);
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(h.layer, NodeServices.layer)));
    },
  );
});
