import { useEffect, useState } from "react";
import { msg, T, useGT } from "gt-react";
import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef, VcsMoveThreadInput } from "@t3tools/contracts";

import { m } from "../i18n/messages";
import { useQuietThreadShell } from "../state/entities";
import { useAtomCommand } from "../state/use-atom-command";
import { vcsEnvironment } from "../state/vcs";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { toastManager } from "./ui/toast";

const OPEN_EVENT = "kinako:move-thread-workspace";

export function requestThreadWorkspaceMove(threadRef: ScopedThreadRef): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: threadRef }));
}

export function ThreadWorkspaceMoveDialog() {
  const [threadRef, setThreadRef] = useState<ScopedThreadRef | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens for the window event that opens the move dialog
  useEffect(() => {
    const open = (event: Event) => setThreadRef((event as CustomEvent<ScopedThreadRef>).detail);
    window.addEventListener(OPEN_EVENT, open);
    return () => window.removeEventListener(OPEN_EVENT, open);
  }, []);
  return threadRef ? (
    <MoveDialog
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      threadRef={threadRef}
      onClose={() => setThreadRef(null)}
    />
  ) : null;
}

function MoveDialog({ threadRef, onClose }: { threadRef: ScopedThreadRef; onClose: () => void }) {
  const gt = useGT();
  const thread = useQuietThreadShell(threadRef);
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState<VcsMoveThreadInput | null>(null);
  const move = useAtomCommand(vcsEnvironment.moveThread, { reportFailure: false });
  const permission = useAtomValue(
    vcsEnvironment.moveThread.permissionAtom(threadRef.environmentId),
  );
  const toLocal = retry ? retry.target === "local" : thread?.worktreePath != null;
  const submit = async (associated = false) => {
    if (!thread || busy) return;
    const input: VcsMoveThreadInput = retry ?? {
      threadId: thread.id,
      expectedWorktreePath: thread.worktreePath,
      target: toLocal
        ? "local"
        : { worktree: associated ? "associated" : { branch: branch.trim() } },
    };
    setBusy(true);
    setError(null);
    const result = await move({ environmentId: threadRef.environmentId, input });
    setBusy(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(
        failure instanceof Error ? failure.message : m(msg("Could not move the workspace.")),
      );
      setRetry(input);
      return;
    }
    if (result.value.cleanupPending) {
      setRetry(input);
      setError(
        m(msg("Workspace moved. Source changes are still present; retry to finish cleanup.")),
      );
      return;
    }
    toastManager.add(
      result.value.setupScript.status === "failed"
        ? {
            type: "error",
            title: m(msg("Workspace moved; setup script failed")),
            description: result.value.setupScript.detail,
          }
        : {
            type: "success",
            title: toLocal
              ? m(msg("Workspace moved to local"))
              : m(msg("Workspace moved to worktree")),
          },
    );
    onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{toLocal ? gt("Move to local") : gt("Move to worktree")}</DialogTitle>
          <DialogDescription>
            {toLocal
              ? gt(
                  "Move this conversation and its uncommitted changes. The thread must be idle and the destination clean. The local checkout will use the worktree's commit in detached HEAD mode when needed. The worktree is retained.",
                )
              : gt(
                  "Move this conversation and its uncommitted changes. The thread must be idle and the destination clean. Enter a new branch name or the branch of an existing worktree at the same commit.",
                )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-6 py-3">
          {!toLocal && (
            <Input
              aria-label={gt("Worktree branch")}
              placeholder="feature/my-change"
              value={branch}
              disabled={busy || retry !== null}
              onChange={(event) => setBranch(event.target.value)}
            />
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            <T>Cancel</T>
          </Button>
          {retry && thread?.worktreePath === retry.expectedWorktreePath && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setRetry(null);
                setError(null);
              }}
            >
              <T>Change destination</T>
            </Button>
          )}
          {!toLocal && !retry && (
            <Button
              variant="outline"
              disabled={busy || !permission}
              onClick={() => void submit(true)}
            >
              <T>Use associated worktree</T>
            </Button>
          )}
          <Button
            disabled={busy || !permission || (!toLocal && !retry && !branch.trim())}
            onClick={() => void submit()}
          >
            {busy ? gt("Moving…") : retry ? gt("Retry") : gt("Move")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
