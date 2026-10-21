import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";
import { makeThreadFixture } from "./test-fixtures";
import {
  getOrphanedAdditionalWorktreesForThread,
  getOrphanedWorktreePathForThread,
} from "./worktreeCleanup";

const localEnvironmentId = EnvironmentId.make("environment-local");

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return makeThreadFixture({
    id: ThreadId.make("thread-1"),
    environmentId: localEnvironmentId,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.3-codex",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    runtime: null,
    messages: [],
    proposedPlans: [],
    createdAt: "2026-02-13T00:00:00.000Z",
    updatedAt: "2026-02-13T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestRun: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  });
}

describe("getOrphanedWorktreePathForThread", () => {
  it("returns null when another thread links to the same worktree", () => {
    const threads = [
      makeThread({
        id: ThreadId.make("thread-1"),
        worktreePath: "/tmp/repo/worktrees/feature-a",
      }),
      makeThread({
        id: ThreadId.make("thread-2"),
        worktreePath: "/tmp/repo/worktrees/feature-a",
      }),
    ];
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.make("thread-1"));
    expect(result).toBeNull();
  });

  it("ignores threads linked to different worktrees", () => {
    const threads = [
      makeThread({
        id: ThreadId.make("thread-1"),
        worktreePath: "/tmp/repo/worktrees/feature-a",
      }),
      makeThread({
        id: ThreadId.make("thread-2"),
        worktreePath: "/tmp/repo/worktrees/feature-b",
      }),
    ];
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.make("thread-1"));
    expect(result).toBe("/tmp/repo/worktrees/feature-a");
  });
});

describe("getOrphanedAdditionalWorktreesForThread", () => {
  it("returns only additional worktrees no other thread uses, with their repository", () => {
    const shared = {
      path: "/repos/api",
      mode: "worktree" as const,
      branch: "feature",
      worktreePath: "/worktrees/api/feature",
    };
    const own = {
      path: "/repos/docs",
      mode: "worktree" as const,
      branch: "feature",
      worktreePath: "/worktrees/docs/feature",
    };
    const local = { path: "/repos/lib", mode: "local" as const, branch: null, worktreePath: null };
    const target = makeThread({
      id: ThreadId.make("thread-target"),
      additionalDirectories: [shared, own, local],
    });
    const sibling = makeThread({
      id: ThreadId.make("thread-sibling"),
      additionalDirectories: [shared],
    });

    expect(getOrphanedAdditionalWorktreesForThread([target, sibling], target.id)).toEqual([
      { repository: "/repos/docs", worktreePath: "/worktrees/docs/feature" },
    ]);
  });
});
