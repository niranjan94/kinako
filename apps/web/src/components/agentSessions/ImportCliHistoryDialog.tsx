import { useAtomValue } from "@effect/atom-react";
import {
  AGENT_SESSION_AGE_WINDOWS,
  AgentSessionProjectCreateInterrupted,
  DEFAULT_AGENT_SESSION_AGE_WINDOW,
  EMPTY_AGENT_SESSION_IMPORT_PROGRESS,
  agentSessionImportRetryPlan,
  agentSessionKey,
  applyAgentSessionImportEvent,
  createAgentSessionProjectEnsurer,
  defaultSelectedAgentSessions,
  groupAgentSessionProjects,
  runAgentSessionHistoryImport,
  summarizeAgentSessionImport,
  toggleAgentSessionSelection,
  type AgentSessionAgeWindow,
  type AgentSessionFolderSelection,
  type AgentSessionImportFolder,
  type AgentSessionImportProgress,
  type AgentSessionImportStatus,
} from "@t3tools/client-runtime/agentSessionHistoryImport";
import { isAgentSessionRecentlyActive } from "@t3tools/client-runtime/agentSessionImport";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { findProjectByPath } from "@t3tools/client-runtime/state/projects";
import {
  CommandId,
  ProviderDriverKind,
  type AgentSessionListItem,
  type AgentSessionProjectCandidate,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useRef, useState } from "react";

import { newProjectId } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { agentSessionScan } from "~/state/agentSessions";
import { readProjects } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { projectEnvironment } from "~/state/projects";
import { formatEnvironmentQueryError } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";

/** Which environment has the dialog open; entry points set it and the app shell renders it. */
const importCliHistoryDialogEnvironmentAtom = Atom.make<EnvironmentId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("agent-sessions:import-history-dialog-environment"),
);

export function openImportCliHistoryDialog(environmentId: EnvironmentId): void {
  appAtomRegistry.set(importCliHistoryDialogEnvironmentAtom, environmentId);
}

function closeImportCliHistoryDialog(): void {
  appAtomRegistry.set(importCliHistoryDialogEnvironmentAtom, null);
}

export function ImportCliHistoryDialogHost() {
  const environmentId = useAtomValue(importCliHistoryDialogEnvironmentAtom);
  if (environmentId === null) return null;
  return <ImportCliHistoryDialog key={environmentId} environmentId={environmentId} />;
}

type FolderSessions =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | {
      readonly status: "ready";
      readonly sessions: ReadonlyArray<AgentSessionListItem>;
      readonly truncated: boolean;
      readonly loadedAtMs: number;
    };

const SCAN_LIMIT_MESSAGE = "Scan limit reached. Some folders or sessions may be missing.";

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

function providerLabel(provider: AgentSessionListItem["provider"]): string {
  return provider === "claudeAgent" ? "Claude Code" : "Codex";
}

function scanInputFor(ageWindow: AgentSessionAgeWindow) {
  return ageWindow.maxAgeMs === undefined ? {} : { maxAgeMs: ageWindow.maxAgeMs };
}

function ImportCliHistoryDialog({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { environments } = useEnvironments();
  const environmentLabel =
    environments.find((environment) => environment.environmentId === environmentId)?.label ??
    "this computer";
  const [ageWindow, setAgeWindow] = useState<AgentSessionAgeWindow>(
    DEFAULT_AGENT_SESSION_AGE_WINDOW,
  );
  const scanAtom = agentSessionScan({ environmentId, input: scanInputFor(ageWindow) });
  const scanResult = useAtomValue(scanAtom);
  const scan = Option.getOrNull(AsyncResult.value(scanResult));
  const canImport = useAtomValue(
    serverEnvironment.importAgentSession.permissionAtom(environmentId),
  );
  const listSessions = useAtomCommand(serverEnvironment.listAgentSessions, {
    reportFailure: false,
  });
  const importSession = useAtomCommand(serverEnvironment.importAgentSession, {
    reportFailure: false,
  });
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });

  const [selection, setSelection] = useState<ReadonlyMap<string, AgentSessionFolderSelection>>(
    () => new Map(),
  );
  const [folderSessions, setFolderSessions] = useState<ReadonlyMap<string, FolderSessions>>(
    () => new Map(),
  );
  const [progress, setProgress] = useState<AgentSessionImportProgress | null>(null);
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const stopRef = useRef(false);
  const ageWindowKeyRef = useRef(ageWindow.key);
  const ensureProjectRef = useRef<ReturnType<typeof createAgentSessionProjectEnsurer> | null>(null);

  const candidates = scan?.candidates ?? [];
  const candidateByPath = new Map(candidates.map((candidate) => [candidate.path, candidate]));

  const fetchFolderSessions = async (path: string) => {
    const result = await listSessions({
      environmentId,
      input: { workspaceRoot: path, ...scanInputFor(ageWindow) },
    });
    if (result._tag === "Success") return result.value;
    throw new Error(
      isAtomCommandInterrupted(result)
        ? "Listing sessions was interrupted."
        : failureMessage(squashAtomCommandFailure(result), "Could not list sessions."),
    );
  };

  const loadFolder = async (path: string) => {
    if (folderSessions.get(path)?.status === "ready") return;
    const requestedAgeWindowKey = ageWindow.key;
    setFolderSessions((current) => new Map(current).set(path, { status: "loading" }));
    const next: FolderSessions = await fetchFolderSessions(path).then(
      (listed) => ({
        status: "ready",
        sessions: listed.sessions,
        truncated: listed.truncated === true,
        loadedAtMs: Date.now(),
      }),
      (error: unknown) => ({
        status: "error",
        message: failureMessage(error, "Could not list sessions."),
      }),
    );
    // A listing for a period the user has since switched away from must not land in the new one.
    if (ageWindowKeyRef.current !== requestedAgeWindowKey) return;
    setFolderSessions((current) => new Map(current).set(path, next));
  };

  const markFolderSessionImported = (path: string, key: string, threadId: ThreadId) =>
    setFolderSessions((current) => {
      const listed = current.get(path);
      if (listed?.status !== "ready") return current;
      return new Map(current).set(path, {
        ...listed,
        sessions: listed.sessions.map((session) =>
          agentSessionKey(session) === key ? { ...session, importedThreadId: threadId } : session,
        ),
      });
    });

  const ensureProject = () => {
    ensureProjectRef.current ??= createAgentSessionProjectEnsurer({
      findProjectId: (path) =>
        findProjectByPath(
          readProjects().filter((project) => project.environmentId === environmentId),
          path,
        )?.id ?? null,
      newIds: () => {
        const projectId = newProjectId();
        return { projectId, commandId: CommandId.make(`cli-history:project:create:${projectId}`) };
      },
      createProject: async ({ projectId, commandId, folder }) => {
        const result = await createProject({
          environmentId,
          input: {
            projectId,
            commandId,
            title: folder.title,
            workspaceRoot: folder.path,
            createWorkspaceRootIfMissing: false,
            defaultModelSelection: null,
          },
        });
        if (result._tag === "Success") return;
        if (isAtomCommandInterrupted(result)) throw new AgentSessionProjectCreateInterrupted();
        throw new Error(
          failureMessage(squashAtomCommandFailure(result), "Could not add the project."),
        );
      },
    });
    return ensureProjectRef.current;
  };

  const runImport = async (plan: ReadonlyArray<AgentSessionImportFolder>) => {
    if (running || plan.length === 0) return;
    stopRef.current = false;
    setStopping(false);
    setRunning(true);
    setProgress((current) => current ?? EMPTY_AGENT_SESSION_IMPORT_PROGRESS);
    try {
      await runAgentSessionHistoryImport(plan, {
        nowMs: Date.now,
        listSessions: async (folder) => (await fetchFolderSessions(folder.path)).sessions,
        ensureProject: ensureProject(),
        importSession: async (projectId, session) => {
          const result = await importSession({
            environmentId,
            input: {
              projectId,
              providerInstanceId: session.providerInstanceId,
              providerSessionId: session.providerSessionId,
            },
          });
          if (result._tag === "Success") return result.value;
          throw new Error(
            isAtomCommandInterrupted(result)
              ? "The import was interrupted."
              : failureMessage(squashAtomCommandFailure(result), "Could not import the session."),
          );
        },
        shouldStop: () => stopRef.current,
        onEvent: (event) => {
          if (event.type === "session") {
            const key = agentSessionKey(event.session);
            setCurrentKey(event.result.status === "importing" ? key : null);
            if (event.result.status === "imported" || event.result.status === "already-imported") {
              markFolderSessionImported(event.folder.path, key, event.result.threadId);
            }
          }
          setProgress((current) =>
            applyAgentSessionImportEvent(current ?? EMPTY_AGENT_SESSION_IMPORT_PROGRESS, event),
          );
        },
      });
    } finally {
      setCurrentKey(null);
      setRunning(false);
      setStopping(false);
      setSelection(new Map());
      appAtomRegistry.refresh(scanAtom);
    }
  };

  const selectedPlan: ReadonlyArray<AgentSessionImportFolder> = [...selection.entries()].flatMap(
    ([path, folderSelection]) => {
      const candidate = candidateByPath.get(path);
      if (candidate === undefined) return [];
      const listed = folderSessions.get(path);
      return [
        {
          path,
          title: candidate.title,
          projectId: candidate.projectId ?? null,
          selection: folderSelection,
          ...(listed?.status === "ready" ? { sessions: listed.sessions } : {}),
        },
      ];
    },
  );
  const retryPlan = progress === null ? [] : agentSessionImportRetryPlan(progress);
  const summary = progress === null ? null : summarizeAgentSessionImport(progress);

  const setFolderChecked = (path: string, checked: boolean) =>
    setSelection((current) => {
      const next = new Map(current);
      if (checked) next.set(path, "all");
      else next.delete(path);
      return next;
    });

  const setSessionChecked = (path: string, session: AgentSessionListItem, checked: boolean) => {
    const listed = folderSessions.get(path);
    if (listed?.status !== "ready") return;
    setSelection((current) => {
      const next = new Map(current);
      const folderSelection = toggleAgentSessionSelection({
        selection: current.get(path),
        sessions: listed.sessions,
        key: agentSessionKey(session),
        checked,
        nowMs: listed.loadedAtMs,
      });
      if (folderSelection === undefined) next.delete(path);
      else next.set(path, folderSelection);
      return next;
    });
  };

  const { repositories, other } = groupAgentSessionProjects(candidates);
  const folderRow = (candidate: AgentSessionProjectCandidate, nested: boolean) => (
    <FolderRow
      key={candidate.path}
      candidate={candidate}
      nested={nested}
      disabled={running}
      selection={selection.get(candidate.path)}
      sessions={folderSessions.get(candidate.path)}
      progress={progress}
      currentKey={currentKey}
      onExpand={() => void loadFolder(candidate.path)}
      onFolderChecked={(checked) => setFolderChecked(candidate.path, checked)}
      onSessionChecked={(session, checked) => setSessionChecked(candidate.path, session, checked)}
    />
  );

  const failures =
    progress === null
      ? []
      : [
          ...[...progress.failedFolders.values()].map(({ folder, reason }) => ({
            key: `folder:${folder.path}`,
            label: folder.title,
            detail: folder.path,
            reason,
          })),
          ...[...progress.sessions.values()].flatMap(({ folder, session, result }) =>
            result.status === "failed"
              ? [
                  {
                    key: agentSessionKey(session),
                    label: session.title.trim() || "Untitled session",
                    detail: folder.path,
                    reason: result.reason,
                  },
                ]
              : [],
          ),
        ];

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !running) closeImportCliHistoryDialog();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import CLI history</DialogTitle>
          <DialogDescription>
            Claude Code and Codex sessions found on {environmentLabel}. Folders without a project
            are added as projects.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Select
              value={ageWindow.key}
              items={Object.fromEntries(
                AGENT_SESSION_AGE_WINDOWS.map((option) => [option.key, option.label]),
              )}
              disabled={running}
              onValueChange={(value) => {
                const next = AGENT_SESSION_AGE_WINDOWS.find((option) => option.key === value);
                if (next === undefined) return;
                ageWindowKeyRef.current = next.key;
                setAgeWindow(next);
                setSelection(new Map());
                setFolderSessions(new Map());
              }}
            >
              <SelectTrigger aria-label="Session age">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {AGENT_SESSION_AGE_WINDOWS.map((option) => (
                  <SelectItem key={option.key} value={option.key}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {candidates.length > 0 ? (
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={running}
                  onClick={() =>
                    setSelection(new Map(candidates.map((candidate) => [candidate.path, "all"])))
                  }
                >
                  Select all
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={running || selection.size === 0}
                  onClick={() => setSelection(new Map())}
                >
                  Select none
                </Button>
              </div>
            ) : null}
          </div>
          {scan?.truncated ? (
            <p className="mt-2 text-muted-foreground text-xs" role="status">
              {SCAN_LIMIT_MESSAGE}
            </p>
          ) : null}
          <ScrollArea scrollFade className="mt-3 h-auto max-h-96">
            <div key={ageWindow.key} className="space-y-1 pr-3">
              {scan === null && scanResult._tag !== "Failure" ? (
                <div className="flex items-center gap-2 py-6 text-muted-foreground text-sm">
                  <Spinner size="sm" />
                  Looking for sessions
                </div>
              ) : scanResult._tag === "Failure" && scan === null ? (
                <div className="flex flex-col items-start gap-3 py-2">
                  <p className="text-destructive text-sm">
                    {formatEnvironmentQueryError(scanResult.cause)}
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => appAtomRegistry.refresh(scanAtom)}
                  >
                    Retry
                  </Button>
                </div>
              ) : candidates.length === 0 ? (
                <p className="py-6 text-muted-foreground text-sm">
                  No Claude Code or Codex sessions found in this period.
                </p>
              ) : (
                <>
                  {repositories.map((group) =>
                    group.candidates.length === 1 ? (
                      folderRow(group.candidates[0]!, false)
                    ) : (
                      <div key={group.key}>
                        <p className="px-2 pt-2 pb-1 font-medium text-muted-foreground text-xs">
                          {group.label}
                        </p>
                        {group.candidates.map((candidate) => folderRow(candidate, true))}
                      </div>
                    ),
                  )}
                  {other.length > 0 ? (
                    <div>
                      <p className="px-2 pt-2 pb-1 font-medium text-muted-foreground text-xs">
                        Other folders
                      </p>
                      {other.map((candidate) => folderRow(candidate, true))}
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </ScrollArea>
          {summary !== null ? (
            <div className="mt-4 space-y-2">
              <p className="text-sm" role="status">
                {running ? (stopping ? "Stopping after the current session. " : "Importing. ") : ""}
                {summary.imported} imported, {summary.alreadyImported} already imported,{" "}
                {summary.failed} failed.
              </p>
              {failures.length > 0 ? (
                <ul className="max-h-32 space-y-1 overflow-y-auto text-xs">
                  {failures.map((failure) => (
                    <li key={failure.key} className="min-w-0">
                      <span className="font-medium">{failure.label}</span>{" "}
                      <span className="text-muted-foreground">{failure.detail}</span>
                      <p className="text-destructive">{failure.reason}</p>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          {running ? (
            <Button
              variant="outline"
              disabled={stopping}
              onClick={() => {
                stopRef.current = true;
                setStopping(true);
              }}
            >
              Stop after current
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={closeImportCliHistoryDialog}>
                {progress === null ? "Cancel" : "Done"}
              </Button>
              {retryPlan.length > 0 ? (
                <Button
                  variant="outline"
                  disabled={!canImport}
                  onClick={() => void runImport(retryPlan)}
                >
                  Retry failed
                </Button>
              ) : null}
              <Button
                disabled={!canImport || selectedPlan.length === 0}
                onClick={() => void runImport(selectedPlan)}
              >
                Import {selectedPlan.length} {selectedPlan.length === 1 ? "folder" : "folders"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function FolderRow(props: {
  readonly candidate: AgentSessionProjectCandidate;
  readonly nested: boolean;
  readonly disabled: boolean;
  readonly selection: AgentSessionFolderSelection | undefined;
  readonly sessions: FolderSessions | undefined;
  readonly progress: AgentSessionImportProgress | null;
  readonly currentKey: string | null;
  readonly onExpand: () => void;
  readonly onFolderChecked: (checked: boolean) => void;
  readonly onSessionChecked: (session: AgentSessionListItem, checked: boolean) => void;
}) {
  const { candidate, selection, sessions } = props;
  const isPartial = selection !== undefined && selection !== "all";
  return (
    <Collapsible
      onOpenChange={(open) => {
        if (open) props.onExpand();
      }}
    >
      <div
        className={
          props.nested
            ? "flex items-center gap-2.5 rounded-md py-1.5 pr-2 pl-5 hover:bg-muted/40"
            : "flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted/40"
        }
      >
        <Checkbox
          aria-label={`Import ${candidate.title}`}
          checked={selection !== undefined && !isPartial}
          indeterminate={isPartial}
          disabled={props.disabled}
          onCheckedChange={(checked) => props.onFolderChecked(checked === true)}
        />
        <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-1.5 text-left">
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-90" />
          <span className="min-w-0 flex-1 truncate">
            <span className="text-sm">{candidate.title}</span>{" "}
            <span className="font-mono text-2xs text-muted-foreground">{candidate.path}</span>
          </span>
          <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
            {candidate.threadCount} {candidate.threadCount === 1 ? "session" : "sessions"}
            {candidate.alreadyImported ? " · project exists" : ""}
          </span>
        </CollapsibleTrigger>
      </div>
      <CollapsiblePanel>
        <div className="pb-1 pl-11">
          {sessions === undefined || sessions.status === "loading" ? (
            <div className="flex items-center gap-2 py-2 text-muted-foreground text-xs">
              <Spinner size="sm" />
              Loading sessions
            </div>
          ) : sessions.status === "error" ? (
            <p className="py-2 text-destructive text-xs">{sessions.message}</p>
          ) : sessions.sessions.length === 0 ? (
            <p className="py-2 text-muted-foreground text-xs">No sessions in this period.</p>
          ) : (
            <>
              {sessions.sessions.map((session) => (
                <SessionRow
                  key={agentSessionKey(session)}
                  session={session}
                  checked={
                    selection === "all"
                      ? defaultSelectedAgentSessions([session], sessions.loadedAtMs).length > 0
                      : selection?.has(agentSessionKey(session)) === true
                  }
                  recentlyActive={isAgentSessionRecentlyActive(session, sessions.loadedAtMs)}
                  result={props.progress?.sessions.get(agentSessionKey(session))?.result}
                  importing={props.currentKey === agentSessionKey(session)}
                  disabled={props.disabled}
                  onCheckedChange={(checked) => props.onSessionChecked(session, checked)}
                />
              ))}
              {sessions.truncated ? (
                <p className="py-1 text-muted-foreground text-xs">
                  Showing the newest {sessions.sessions.length} sessions.
                </p>
              ) : null}
            </>
          )}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function SessionRow(props: {
  readonly session: AgentSessionListItem;
  readonly checked: boolean;
  readonly recentlyActive: boolean;
  readonly result: AgentSessionImportStatus | undefined;
  readonly importing: boolean;
  readonly disabled: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  const { session, result } = props;
  const label = providerLabel(session.provider);
  const imported =
    session.importedThreadId !== null ||
    result?.status === "imported" ||
    result?.status === "already-imported";
  return (
    <label className="flex min-w-0 cursor-pointer items-center gap-2.5 py-1 has-disabled:cursor-default">
      <Checkbox
        checked={props.checked && !imported}
        disabled={props.disabled || imported}
        onCheckedChange={(checked) => props.onCheckedChange(checked === true)}
      />
      <span role="img" aria-label={label}>
        <ProviderInstanceIcon
          driverKind={ProviderDriverKind.make(session.provider)}
          displayName={label}
          iconClassName="size-3.5"
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{session.title.trim() || "Untitled session"}</span>
        {props.recentlyActive && !imported ? (
          <span className="block text-warning-foreground text-xs">
            May still be open in a terminal. Close it there first.
          </span>
        ) : null}
        {result?.status === "failed" ? (
          <span className="block text-destructive text-xs">{result.reason}</span>
        ) : null}
      </span>
      <span className="shrink-0 text-muted-foreground text-xs">
        {props.importing ? (
          <Spinner size="sm" />
        ) : imported ? (
          "Imported"
        ) : (
          formatRelativeTimeLabel(session.updatedAt)
        )}
      </span>
    </label>
  );
}
