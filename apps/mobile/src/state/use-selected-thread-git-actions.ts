import { useCallback, useMemo, useRef } from "react";
import { useAtomMount } from "@effect/atom-react";

import { EnvironmentProject, EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  createVcsStatusRevalidationAtomFamily,
  type GitActionRequestInput,
  type VcsActionOperation,
  type VcsRef,
} from "@t3tools/client-runtime/state/vcs";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentAuthorizationError,
  ThreadWorkspaceError,
  type GitRunStackedActionResult,
  type VcsMoveThreadInput,
} from "@t3tools/contracts";
import {
  dedupeRemoteBranchesWithLocalMatches,
  sanitizeFeatureBranchName,
} from "@t3tools/shared/git";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import { useBranches } from "../state/queries";
import { threadEnvironment } from "../state/threads";
import { vcsActionManager, vcsEnvironment } from "../state/vcs";
import { uuidv4 } from "../lib/uuid";
import { appAtomRegistry } from "./atom-registry";
import { readEnvironmentScope, useEnvironmentScope } from "./session";
import {
  environmentConnectedAtom,
  setPendingConnectionError,
} from "./use-remote-environment-registry";
import { useAtomCommand } from "./use-atom-command";
import { showGitActionResult } from "./use-vcs-action-state";
import { useThreadSelection } from "./use-thread-selection";
import { useSelectedThreadWorktree } from "./use-selected-thread-worktree";

function refreshFailureMessage(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : "Failed to refresh git status.";
}

// Selecting a thread or reconnecting its environment refreshes the checkout's
// status once, shared by every sheet that shows it.
const selectedThreadStatusRevalidation = createVcsStatusRevalidationAtomFamily({
  refreshStatus: vcsEnvironment.refreshStatus,
  connected: environmentConnectedAtom,
  onRefreshed: (result) =>
    setPendingConnectionError(
      AsyncResult.isFailure(result) ? refreshFailureMessage(result.cause) : null,
    ),
});

export function useSelectedThreadGitActions() {
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const refreshStatus = useAtomCommand(vcsEnvironment.refreshStatus, { reportFailure: false });
  const switchRef = useAtomCommand(vcsEnvironment.switchRef, { reportFailure: false });
  const createRef = useAtomCommand(vcsEnvironment.createRef, { reportFailure: false });
  const moveThread = useAtomCommand(vcsEnvironment.moveThread, { reportFailure: false });
  const pendingWorkspaceMove = useRef<{ environmentId: string; input: VcsMoveThreadInput } | null>(
    null,
  );
  const pull = useAtomCommand(vcsEnvironment.pull, { reportFailure: false });
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const canWriteSourceControl = useEnvironmentScope(
    selectedThread?.environmentId ?? null,
    AuthSourceControlWriteScope,
  );
  const canOperateThread = useEnvironmentScope(
    selectedThread?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const canChangeThreadBranch = canWriteSourceControl && canOperateThread;
  const { selectedThreadCwd, selectedThreadWorktreePath } = useSelectedThreadWorktree();
  const runStackedAction = useAtomCommand(
    vcsActionManager.runStackedAction({
      environmentId: selectedThread?.environmentId ?? null,
      cwd: selectedThreadCwd,
    }),
    { reportFailure: false },
  );

  const selectedThreadGitRootCwd = selectedThreadProject?.workspaceRoot ?? null;
  const branchTarget = useMemo(
    () => ({
      environmentId: selectedThread?.environmentId ?? null,
      cwd: selectedThreadGitRootCwd,
      query: null,
    }),
    [selectedThread?.environmentId, selectedThreadGitRootCwd],
  );
  const branchState = useBranches(branchTarget);
  const updateThreadGitContext = useCallback(
    async (
      thread: NonNullable<typeof selectedThread>,
      nextState: {
        readonly branch?: string | null;
        readonly worktreePath?: string | null;
      },
    ) => {
      if (!readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)) {
        return AsyncResult.failure<never, EnvironmentAuthorizationError>(
          Cause.fail(
            new EnvironmentAuthorizationError({
              requiredScope: AuthOrchestrationOperateScope,
              message: "This connection cannot update the thread's branch.",
            }),
          ),
        );
      }
      return updateThreadMetadata({
        environmentId: thread.environmentId,
        input: {
          threadId: thread.id,
          ...(nextState.branch !== undefined ? { branch: nextState.branch } : {}),
          ...(nextState.worktreePath !== undefined ? { worktreePath: nextState.worktreePath } : {}),
        },
      });
    },
    [updateThreadMetadata],
  );

  const refreshSelectedThreadGitStatus = useCallback(
    async (options?: { readonly quiet?: boolean; readonly cwd?: string | null }) => {
      if (!selectedThread || !selectedThreadProject) {
        return null;
      }

      const cwd = options?.cwd ?? selectedThreadCwd;
      if (!cwd) {
        return null;
      }

      const target = { environmentId: selectedThread.environmentId, cwd };
      const execute = () =>
        refreshStatus({
          environmentId: selectedThread.environmentId,
          input: { cwd },
        });
      const result = options?.quiet
        ? await execute()
        : await vcsActionManager.track(
            appAtomRegistry,
            target,
            {
              operation: "refresh_status",
              label: "Refreshing source control status",
            },
            execute,
          );
      if (AsyncResult.isFailure(result)) {
        setPendingConnectionError(refreshFailureMessage(result.cause));
        return null;
      }
      setPendingConnectionError(null);
      return result.value;
    },
    [refreshStatus, selectedThread, selectedThreadCwd, selectedThreadProject],
  );

  useAtomMount(
    selectedThreadStatusRevalidation(
      selectedThread && selectedThreadProject && selectedThreadCwd
        ? { environmentId: selectedThread.environmentId, cwd: selectedThreadCwd }
        : null,
    ),
  );

  const runSelectedThreadGitMutation = useCallback(
    async <T, E>(
      operation: VcsActionOperation,
      label: string,
      execute: (input: {
        readonly thread: EnvironmentThreadShell;
        readonly project: EnvironmentProject;
        readonly cwd: string;
      }) => Promise<AtomCommandResult<T, E>>,
      options?: { readonly managedExternally?: boolean; readonly changesThreadBranch?: boolean },
    ): Promise<T | null> => {
      if (
        !selectedThread ||
        !selectedThreadProject ||
        !selectedThreadCwd ||
        !readEnvironmentScope(selectedThread.environmentId, AuthSourceControlWriteScope) ||
        (options?.changesThreadBranch === true &&
          !readEnvironmentScope(selectedThread.environmentId, AuthOrchestrationOperateScope))
      ) {
        return null;
      }

      const target = {
        environmentId: selectedThread.environmentId,
        cwd: selectedThreadCwd,
      };
      setPendingConnectionError(null);
      const run = () =>
        execute({
          thread: selectedThread,
          project: selectedThreadProject,
          cwd: selectedThreadCwd,
        });
      const result =
        options?.managedExternally === true
          ? await run()
          : await vcsActionManager.track(appAtomRegistry, target, { operation, label }, run);
      if (AsyncResult.isFailure(result)) {
        const error = Cause.squash(result.cause);
        const message = error instanceof Error ? error.message : "Git action failed.";
        setPendingConnectionError(message);
        showGitActionResult({ type: "error", title: "Git action failed", description: message });
        return null;
      }
      return result.value;
    },
    [selectedThread, selectedThreadCwd, selectedThreadProject],
  );

  const refreshSelectedThreadBranches = useCallback(async (): Promise<ReadonlyArray<VcsRef>> => {
    branchState.refresh();
    return dedupeRemoteBranchesWithLocalMatches(branchState.data?.refs ?? []).filter(
      (branch) => !branch.isRemote,
    );
  }, [branchState]);

  const syncSelectedThreadBranchState = useCallback(
    async (input: {
      readonly thread: EnvironmentThreadShell;
      readonly cwd: string;
      readonly nextThreadState?: {
        readonly branch?: string | null;
        readonly worktreePath?: string | null;
      };
    }): Promise<AtomCommandResult<void, unknown>> => {
      // Git already changed; refresh even if metadata updates fail so the sheet shows the current branch.
      const updateResult = input.nextThreadState
        ? await updateThreadGitContext(input.thread, input.nextThreadState)
        : AsyncResult.success(undefined);
      branchState.refresh();
      await refreshSelectedThreadGitStatus({ quiet: true, cwd: input.cwd });
      return AsyncResult.isFailure(updateResult)
        ? AsyncResult.failure(updateResult.cause)
        : AsyncResult.success(undefined);
    },
    [branchState, refreshSelectedThreadGitStatus, updateThreadGitContext],
  );

  const onCheckoutSelectedThreadBranch = useCallback(
    async (branch: string) => {
      return runSelectedThreadGitMutation(
        "switch_ref",
        "Switching branch",
        async ({ thread, cwd }) => {
          const result = await switchRef({
            environmentId: thread.environmentId,
            input: { cwd, refName: branch },
          });
          if (AsyncResult.isFailure(result)) {
            return result;
          }
          const syncResult = await syncSelectedThreadBranchState({
            thread,
            cwd,
            nextThreadState: {
              branch: result.value.refName ?? thread.branch,
              worktreePath: selectedThreadWorktreePath,
            },
          });
          return AsyncResult.isFailure(syncResult) ? AsyncResult.failure(syncResult.cause) : result;
        },
        { changesThreadBranch: true },
      );
    },
    [
      runSelectedThreadGitMutation,
      selectedThreadWorktreePath,
      syncSelectedThreadBranchState,
      switchRef,
    ],
  );

  const onCreateSelectedThreadBranch = useCallback(
    async (branch: string) => {
      return runSelectedThreadGitMutation(
        "create_ref",
        "Creating branch",
        async ({ thread, cwd }) => {
          const result = await createRef({
            environmentId: thread.environmentId,
            input: { cwd, refName: branch, switchRef: true },
          });
          if (AsyncResult.isFailure(result)) {
            return result;
          }
          const syncResult = await syncSelectedThreadBranchState({
            thread,
            cwd,
            nextThreadState: {
              branch: result.value.refName ?? thread.branch,
              worktreePath: selectedThreadWorktreePath,
            },
          });
          return AsyncResult.isFailure(syncResult) ? AsyncResult.failure(syncResult.cause) : result;
        },
        { changesThreadBranch: true },
      );
    },
    [
      runSelectedThreadGitMutation,
      selectedThreadWorktreePath,
      syncSelectedThreadBranchState,
      createRef,
    ],
  );

  const onMoveSelectedThreadWorkspace = useCallback(
    async (target: VcsMoveThreadInput["target"]) =>
      runSelectedThreadGitMutation(
        "create_worktree",
        "Moving workspace",
        async ({ thread }) => {
          const pending = pendingWorkspaceMove.current;
          const input =
            pending?.environmentId === thread.environmentId && pending.input.threadId === thread.id
              ? pending.input
              : {
                  threadId: thread.id,
                  expectedWorktreePath: thread.worktreePath,
                  target,
                };
          pendingWorkspaceMove.current = { environmentId: thread.environmentId, input };
          const result = await moveThread({ environmentId: thread.environmentId, input });
          if (
            AsyncResult.isFailure(result) &&
            Cause.squash(result.cause) instanceof ThreadWorkspaceError
          )
            pendingWorkspaceMove.current = null;
          if (AsyncResult.isSuccess(result) && !result.value.cleanupPending)
            pendingWorkspaceMove.current = null;
          if (AsyncResult.isSuccess(result) && result.value.cleanupPending)
            showGitActionResult({
              type: "error",
              title: "Workspace moved; source changes retained",
              description:
                "Source cleanup could not finish. Both copies of your changes are preserved.",
            });
          else if (AsyncResult.isSuccess(result) && result.value.setupScript.status === "failed")
            showGitActionResult({
              type: "error",
              title: "Workspace moved; setup script failed",
              description: result.value.setupScript.detail,
            });
          return result;
        },
        { changesThreadBranch: true },
      ),
    [moveThread, runSelectedThreadGitMutation],
  );

  const onCreateSelectedThreadWorktree = useCallback(
    async (nextWorktree: { readonly baseBranch: string; readonly newBranch: string }) =>
      onMoveSelectedThreadWorkspace({
        worktree: {
          branch: sanitizeFeatureBranchName(nextWorktree.newBranch),
          baseRef: nextWorktree.baseBranch,
        },
      }),
    [onMoveSelectedThreadWorkspace],
  );

  const onPullSelectedThreadBranch = useCallback(async () => {
    await runSelectedThreadGitMutation(
      "pull",
      "Pulling latest changes",
      async ({ thread, cwd }) => {
        const result = await pull({
          environmentId: thread.environmentId,
          input: { cwd },
        });
        if (AsyncResult.isFailure(result)) {
          return result;
        }
        await refreshSelectedThreadGitStatus({ quiet: true, cwd });
        showGitActionResult({
          type: "success",
          title:
            result.value.status === "skipped_up_to_date"
              ? "Already up to date"
              : `Pulled latest on ${result.value.refName}`,
        });
        return result;
      },
    );
  }, [pull, refreshSelectedThreadGitStatus, runSelectedThreadGitMutation]);

  const onRunSelectedThreadGitAction = useCallback(
    async (input: GitActionRequestInput): Promise<GitRunStackedActionResult | null> => {
      const actionId = uuidv4();
      return await runSelectedThreadGitMutation(
        "run_change_request",
        "Running source control action",
        async ({ thread, cwd }) => {
          const result = await runStackedAction({
            actionId,
            action: input.action,
            ...(input.commitMessage ? { commitMessage: input.commitMessage } : {}),
            ...(input.featureBranch ? { featureBranch: input.featureBranch } : {}),
            ...(input.filePaths?.length ? { filePaths: [...input.filePaths] } : {}),
            threadId: thread.id,
          });
          if (AsyncResult.isFailure(result)) {
            return result;
          }

          if (result.value.branch.status === "created" && result.value.branch.name) {
            const syncResult = await syncSelectedThreadBranchState({
              thread,
              cwd,
              nextThreadState: {
                branch: result.value.branch.name,
                worktreePath: selectedThreadWorktreePath,
              },
            });
            if (AsyncResult.isFailure(syncResult)) {
              return AsyncResult.failure(syncResult.cause);
            }
          } else {
            await refreshSelectedThreadGitStatus({ quiet: true, cwd });
          }
          showGitActionResult({
            type: "success",
            title: result.value.toast.title,
            description: result.value.toast.description,
            prUrl:
              result.value.toast.cta.kind === "open_pr" ? result.value.toast.cta.url : undefined,
          });
          return result;
        },
        { managedExternally: true, changesThreadBranch: input.featureBranch === true },
      );
    },
    [
      runStackedAction,
      refreshSelectedThreadGitStatus,
      runSelectedThreadGitMutation,
      selectedThreadWorktreePath,
      syncSelectedThreadBranchState,
    ],
  );

  return {
    canWriteSourceControl,
    canChangeThreadBranch,
    refreshSelectedThreadGitStatus,
    refreshSelectedThreadBranches,
    onCheckoutSelectedThreadBranch,
    onCreateSelectedThreadBranch,
    onCreateSelectedThreadWorktree,
    onMoveSelectedThreadWorkspace,
    onPullSelectedThreadBranch,
    onRunSelectedThreadGitAction,
  };
}
