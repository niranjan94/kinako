import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isAgentSessionRecentlyActive } from "@t3tools/client-runtime/agentSessionImport";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  ProviderDriverKind,
  type AgentSessionListItem,
  type ScopedProjectRef,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { waitForThreadShell } from "~/state/entities";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";

/**
 * Which project has the import dialog open. Entry points (command palette, sidebar, project
 * settings) set it and the app shell renders the dialog once, so it outlives a palette or menu
 * that closes the moment its command runs.
 */
const importAgentSessionDialogProjectAtom = Atom.make<ScopedProjectRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("agent-sessions:import-dialog-project"),
);

export function openImportAgentSessionDialog(projectRef: ScopedProjectRef): void {
  appAtomRegistry.set(importAgentSessionDialogProjectAtom, projectRef);
}

function closeImportAgentSessionDialog(): void {
  appAtomRegistry.set(importAgentSessionDialogProjectAtom, null);
}

export function ImportAgentSessionDialogHost() {
  const projectRef = useAtomValue(importAgentSessionDialogProjectAtom);
  if (projectRef === null) return null;
  return (
    <ImportAgentSessionDialog
      key={`${projectRef.environmentId}:${projectRef.projectId}`}
      projectRef={projectRef}
    />
  );
}

type SessionListState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | {
      readonly status: "ready";
      readonly sessions: ReadonlyArray<AgentSessionListItem>;
      readonly loadedAtMs: number;
    };

function sessionKey(session: AgentSessionListItem): string {
  return `${session.providerInstanceId}:${session.providerSessionId}`;
}

function providerLabel(provider: AgentSessionListItem["provider"]): string {
  return provider === "claudeAgent" ? "Claude Code" : "Codex";
}

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

function ImportAgentSessionDialog({ projectRef }: { readonly projectRef: ScopedProjectRef }) {
  const navigate = useNavigate();
  const listSessions = useAtomCommand(serverEnvironment.listAgentSessions, {
    reportFailure: false,
  });
  const importSession = useAtomCommand(serverEnvironment.importAgentSession, {
    reportFailure: false,
  });
  const canImport = useAtomValue(
    serverEnvironment.importAgentSession.permissionAtom(projectRef.environmentId),
  );
  const [listState, setListState] = useState<SessionListState>({ status: "loading" });
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const fetchSessions = async (): Promise<SessionListState | null> => {
    const result = await listSessions({
      environmentId: projectRef.environmentId,
      input: { projectId: projectRef.projectId },
    });
    if (result._tag === "Success") {
      return { status: "ready", sessions: result.value.sessions, loadedAtMs: Date.now() };
    }
    if (isAtomCommandInterrupted(result)) return null;
    return {
      status: "error",
      message: failureMessage(squashAtomCommandFailure(result), "Could not list sessions."),
    };
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the importable agent sessions from the server when the dialog opens
  useEffect(() => {
    let cancelled = false;
    void fetchSessions().then((next) => {
      if (!cancelled && next !== null) setListState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchSessions]);

  const retry = async () => {
    setListState({ status: "loading" });
    const next = await fetchSessions();
    if (next !== null) setListState(next);
  };

  const openThread = async (threadId: ThreadId) => {
    const threadRef = scopeThreadRef(projectRef.environmentId, threadId);
    if (!(await waitForThreadShell(threadRef))) {
      toastManager.add({
        type: "error",
        title: "Could not open the thread",
        description:
          "The thread exists, but its data did not reach this client. Reconnect and try opening it from the sidebar.",
      });
      return;
    }
    closeImportAgentSessionDialog();
    await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) });
  };

  const runRowAction = async (session: AgentSessionListItem) => {
    if (pendingKey !== null) return;
    setPendingKey(sessionKey(session));
    return await (async () => {
      if (session.importedThreadId !== null) {
        await openThread(session.importedThreadId);
        return;
      }
      const result = await importSession({
        environmentId: projectRef.environmentId,
        input: {
          projectId: projectRef.projectId,
          providerInstanceId: session.providerInstanceId,
          providerSessionId: session.providerSessionId,
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          toastManager.add({
            type: "error",
            title: "Could not import session",
            description: failureMessage(
              squashAtomCommandFailure(result),
              "The session could not be imported.",
            ),
          });
        }
        return;
      }
      if (result.value.imported) {
        toastManager.add({ type: "success", title: "Session imported" });
      }
      await openThread(result.value.threadId);
    })().finally(() => {
      setPendingKey(null);
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && pendingKey === null) closeImportAgentSessionDialog();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Import CLI session</DialogTitle>
          <DialogDescription>
            Continue a Claude Code or Codex session you started in a terminal in this project's
            folder.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {listState.status === "loading" ? (
            <div className="flex items-center gap-2 py-6 text-muted-foreground text-sm">
              <Spinner size="sm" />
              Loading sessions
            </div>
          ) : listState.status === "error" ? (
            <div className="flex flex-col items-start gap-3 py-2">
              <p className="text-destructive text-sm">{listState.message}</p>
              <Button type="button" size="sm" variant="outline" onClick={() => void retry()}>
                Retry
              </Button>
            </div>
          ) : listState.sessions.length === 0 ? (
            <p className="py-6 text-muted-foreground text-sm">
              No Claude Code or Codex sessions found for this folder.
            </p>
          ) : (
            <ul className="divide-y divide-border/60">
              {listState.sessions.map((session) => {
                const key = sessionKey(session);
                const label = providerLabel(session.provider);
                const title = session.title.trim() || "Untitled session";
                const isOpen = session.importedThreadId !== null;
                const isPending = pendingKey === key;
                return (
                  <li key={key} className="flex min-w-0 items-center gap-3 py-2.5">
                    <span role="img" aria-label={label}>
                      <ProviderInstanceIcon
                        driverKind={ProviderDriverKind.make(session.provider)}
                        displayName={label}
                        iconClassName="size-4"
                      />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-foreground text-sm">{title}</p>
                      <p className="text-muted-foreground text-xs">
                        {formatRelativeTimeLabel(session.updatedAt)}
                      </p>
                      {isAgentSessionRecentlyActive(session, listState.loadedAtMs) ? (
                        <p className="text-warning-foreground text-xs">
                          May still be open in a terminal. Close it there first.
                        </p>
                      ) : null}
                    </div>
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={pendingKey !== null || (!isOpen && !canImport)}
                      onClick={() => void runRowAction(session)}
                    >
                      {isOpen ? "Open" : isPending ? "Importing..." : "Import"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
