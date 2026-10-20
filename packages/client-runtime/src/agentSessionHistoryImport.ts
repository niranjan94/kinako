import type {
  AgentSessionListItem,
  AgentSessionProjectCandidate,
  CommandId,
  ProjectId,
  ServerConfig,
  ThreadId,
} from "@t3tools/contracts";

import { isAgentSessionRecentlyActive } from "./agentSessionImport.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export const AGENT_SESSION_AGE_WINDOWS = [
  { key: "30d", label: "Last 30 days", maxAgeMs: 30 * DAY_MS },
  { key: "90d", label: "Last 90 days", maxAgeMs: 90 * DAY_MS },
  { key: "all", label: "All time", maxAgeMs: undefined },
] as const;
export type AgentSessionAgeWindow = (typeof AGENT_SESSION_AGE_WINDOWS)[number];
export const DEFAULT_AGENT_SESSION_AGE_WINDOW: AgentSessionAgeWindow = AGENT_SESSION_AGE_WINDOWS[0];

/** Whether an environment can scan and import CLI history across folders. */
export function supportsAgentSessionHistoryImport(
  serverConfig: Pick<ServerConfig, "environment"> | null | undefined,
): boolean {
  return serverConfig?.environment.capabilities.agentSessionHistoryImport === true;
}

export function agentSessionKey(
  session: Pick<AgentSessionListItem, "providerInstanceId" | "providerSessionId">,
): string {
  return `${session.providerInstanceId}:${session.providerSessionId}`;
}

/** Sessions a folder-wide selection imports: not imported yet and not still open in a terminal. */
export function defaultSelectedAgentSessions(
  sessions: ReadonlyArray<AgentSessionListItem>,
  nowMs: number,
): ReadonlyArray<AgentSessionListItem> {
  return sessions.filter(
    (session) => session.importedThreadId === null && !isAgentSessionRecentlyActive(session, nowMs),
  );
}

export interface AgentSessionProjectGroup<T> {
  readonly key: string;
  readonly label: string;
  readonly repository: string | null;
  readonly candidates: ReadonlyArray<T>;
  readonly threadCount: number;
  readonly lastActiveAt: string | null;
}

function latestActivity(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left > right ? left : right;
}

/**
 * Groups scanned folders that share a Git remote. Folders that are not repositories stay apart
 * in `other`; servers that predate the git scan omit `git` and count as repositories.
 */
export function groupAgentSessionProjects<
  T extends Pick<
    AgentSessionProjectCandidate,
    "path" | "title" | "git" | "threadCount" | "lastActiveAt"
  >,
>(candidates: ReadonlyArray<T>) {
  const groups = new Map<string, AgentSessionProjectGroup<T> & { candidates: Array<T> }>();
  const other: Array<T> = [];

  for (const candidate of candidates) {
    if (candidate.git === null) {
      other.push(candidate);
      continue;
    }
    const git = candidate.git ?? { remoteKey: null, repository: null };
    const key = git.remoteKey === null ? `path:${candidate.path}` : `remote:${git.remoteKey}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        key,
        label: git.repository ?? candidate.title,
        repository: git.repository,
        candidates: [candidate],
        threadCount: candidate.threadCount,
        lastActiveAt: candidate.lastActiveAt,
      });
      continue;
    }
    existing.candidates.push(candidate);
    groups.set(key, {
      ...existing,
      threadCount: existing.threadCount + candidate.threadCount,
      lastActiveAt: latestActivity(existing.lastActiveAt, candidate.lastActiveAt),
    });
  }

  const repositories = [...groups.values()].sort((left, right) => {
    if (left.lastActiveAt === right.lastActiveAt) return left.label.localeCompare(right.label);
    if (left.lastActiveAt === null) return 1;
    if (right.lastActiveAt === null) return -1;
    return right.lastActiveAt.localeCompare(left.lastActiveAt);
  });

  return { repositories, other };
}

/** `"all"` imports the folder's default selection; a set names the chosen session keys. */
export type AgentSessionFolderSelection = "all" | ReadonlySet<string>;

/** Toggles one session, turning a folder-wide selection into the explicit set it stood for. */
export function toggleAgentSessionSelection(input: {
  readonly selection: AgentSessionFolderSelection | undefined;
  readonly sessions: ReadonlyArray<AgentSessionListItem>;
  readonly key: string;
  readonly checked: boolean;
  readonly nowMs: number;
}): AgentSessionFolderSelection | undefined {
  const current =
    input.selection === undefined
      ? new Set<string>()
      : input.selection === "all"
        ? new Set(defaultSelectedAgentSessions(input.sessions, input.nowMs).map(agentSessionKey))
        : new Set(input.selection);
  if (input.checked) current.add(input.key);
  else current.delete(input.key);
  return current.size === 0 ? undefined : current;
}

export interface AgentSessionImportFolder {
  readonly path: string;
  readonly title: string;
  /** The folder's project when it already has one. */
  readonly projectId: ProjectId | null;
  readonly selection: AgentSessionFolderSelection;
  /** The pages already listed for this folder; listed on demand otherwise. */
  readonly listing?: AgentSessionFolderListing;
}

/** Listed sessions, newest first, and when they were listed. */
export interface AgentSessionFolderListing {
  readonly sessions: ReadonlyArray<AgentSessionListItem>;
  /** Where the older sessions start; absent once every page is listed. */
  readonly nextCursor?: number | undefined;
  /** Decides which sessions looked still open, so an import matches what was shown. */
  readonly listedAtMs: number;
}

export type AgentSessionImportStatus =
  | { readonly status: "importing" }
  | { readonly status: "imported"; readonly threadId: ThreadId }
  | { readonly status: "already-imported"; readonly threadId: ThreadId }
  | { readonly status: "failed"; readonly reason: string };

export type AgentSessionImportEvent =
  | {
      readonly type: "session";
      readonly folder: AgentSessionImportFolder;
      readonly session: AgentSessionListItem;
      readonly result: AgentSessionImportStatus;
    }
  | {
      readonly type: "folder-listed";
      readonly folder: AgentSessionImportFolder;
    }
  | {
      readonly type: "folder-failed";
      readonly folder: AgentSessionImportFolder;
      readonly reason: string;
    };

export interface AgentSessionImportProgress {
  readonly sessions: ReadonlyMap<
    string,
    {
      readonly folder: AgentSessionImportFolder;
      readonly session: AgentSessionListItem;
      readonly result: AgentSessionImportStatus;
    }
  >;
  readonly failedFolders: ReadonlyMap<
    string,
    { readonly folder: AgentSessionImportFolder; readonly reason: string }
  >;
}

export const EMPTY_AGENT_SESSION_IMPORT_PROGRESS: AgentSessionImportProgress = {
  sessions: new Map(),
  failedFolders: new Map(),
};

export function applyAgentSessionImportEvent(
  progress: AgentSessionImportProgress,
  event: AgentSessionImportEvent,
): AgentSessionImportProgress {
  if (event.type === "folder-failed") {
    const failedFolders = new Map(progress.failedFolders);
    failedFolders.set(event.folder.path, { folder: event.folder, reason: event.reason });
    return { ...progress, failedFolders };
  }
  if (event.type === "folder-listed") {
    if (!progress.failedFolders.has(event.folder.path)) return progress;
    const failedFolders = new Map(progress.failedFolders);
    failedFolders.delete(event.folder.path);
    return { ...progress, failedFolders };
  }
  const sessions = new Map(progress.sessions);
  sessions.set(agentSessionKey(event.session), {
    folder: event.folder,
    session: event.session,
    result: event.result,
  });
  return { ...progress, sessions };
}

export function summarizeAgentSessionImport(progress: AgentSessionImportProgress) {
  let imported = 0;
  let alreadyImported = 0;
  let failed = progress.failedFolders.size;
  for (const { result } of progress.sessions.values()) {
    if (result.status === "imported") imported += 1;
    else if (result.status === "already-imported") alreadyImported += 1;
    else if (result.status === "failed") failed += 1;
  }
  return { imported, alreadyImported, failed };
}

/** The folders and sessions that failed, as a plan that imports only those again. */
export function agentSessionImportRetryPlan(
  progress: AgentSessionImportProgress,
): ReadonlyArray<AgentSessionImportFolder> {
  const plan = new Map<string, AgentSessionImportFolder>();
  for (const { folder } of progress.failedFolders.values()) {
    const { listing: _staleListing, ...unlisted } = folder;
    plan.set(folder.path, unlisted);
  }
  for (const { folder, session, result } of progress.sessions.values()) {
    if (result.status !== "failed" || plan.has(folder.path)) continue;
    const existing = plan.get(`session:${folder.path}`);
    const sessions = [...(existing?.listing?.sessions ?? []), session];
    plan.set(`session:${folder.path}`, {
      ...folder,
      selection: new Set(sessions.map(agentSessionKey)),
      listing: { sessions, listedAtMs: folder.listing?.listedAtMs ?? 0 },
    });
  }
  return [...plan.values()];
}

export interface AgentSessionHistoryImportDeps {
  readonly nowMs: () => number;
  /** Lists one page from `cursor`, or the first page; rejects with the reason it failed. */
  readonly listSessions: (
    folder: AgentSessionImportFolder,
    cursor: number | undefined,
  ) => Promise<Omit<AgentSessionFolderListing, "listedAtMs">>;
  /** Resolves the folder's project, creating it when needed; rejects with the reason. */
  readonly ensureProject: (folder: AgentSessionImportFolder) => Promise<ProjectId>;
  /** Rejects with the reason the session could not be imported. */
  readonly importSession: (
    projectId: ProjectId,
    session: AgentSessionListItem,
  ) => Promise<{ readonly threadId: ThreadId; readonly imported: boolean }>;
  /** Checked between requests, so a stop keeps what already finished. */
  readonly shouldStop: () => boolean;
  readonly onEvent: (event: AgentSessionImportEvent) => void;
}

function failureReason(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : "Unknown error.";
}

/** Imports the chosen sessions one request at a time, reporting each outcome as it lands. */
export async function runAgentSessionHistoryImport(
  plan: ReadonlyArray<AgentSessionImportFolder>,
  deps: AgentSessionHistoryImportDeps,
): Promise<void> {
  for (const folder of plan) {
    if (deps.shouldStop() || !(await importFolder(folder, deps))) return;
  }
}

/** Imports one folder's chosen sessions; false when a stop was requested. */
async function importFolder(
  folder: AgentSessionImportFolder,
  deps: AgentSessionHistoryImportDeps,
): Promise<boolean> {
  const { selection } = folder;
  let listing = folder.listing;
  let cursor: number | undefined;
  let projectId: ProjectId | null = null;
  for (let page = 0; ; page++) {
    if (listing === undefined) {
      try {
        listing = { ...(await deps.listSessions(folder, cursor)), listedAtMs: deps.nowMs() };
      } catch (error) {
        deps.onEvent({ type: "folder-failed", folder, reason: failureReason(error) });
        return true;
      }
    }
    if (page === 0) deps.onEvent({ type: "folder-listed", folder });
    const { listedAtMs } = listing;
    // A folder-wide selection still reports the sessions an earlier import already brought in.
    const chosen =
      selection === "all"
        ? listing.sessions.filter(
            (session) =>
              session.importedThreadId !== null ||
              !isAgentSessionRecentlyActive(session, listedAtMs),
          )
        : listing.sessions.filter((session) => selection.has(agentSessionKey(session)));
    const pending: Array<AgentSessionListItem> = [];
    for (const session of chosen) {
      if (session.importedThreadId === null) {
        pending.push(session);
        continue;
      }
      deps.onEvent({
        type: "session",
        folder,
        session,
        result: { status: "already-imported", threadId: session.importedThreadId },
      });
    }

    if (pending.length > 0) {
      if (deps.shouldStop()) return false;
      if (projectId === null) {
        try {
          projectId = await deps.ensureProject(folder);
        } catch (error) {
          const reason = failureReason(error);
          for (const session of pending) {
            deps.onEvent({
              type: "session",
              folder,
              session,
              result: { status: "failed", reason },
            });
          }
          return true;
        }
      }
      for (const session of pending) {
        if (deps.shouldStop()) return false;
        deps.onEvent({ type: "session", folder, session, result: { status: "importing" } });
        try {
          const result = await deps.importSession(projectId, session);
          deps.onEvent({
            type: "session",
            folder,
            session,
            result: {
              status: result.imported ? "imported" : "already-imported",
              threadId: result.threadId,
            },
          });
        } catch (error) {
          deps.onEvent({
            type: "session",
            folder,
            session,
            result: { status: "failed", reason: failureReason(error) },
          });
        }
      }
    }

    // An explicit selection names sessions already listed; a folder-wide one reads every page.
    if (selection !== "all" || listing.nextCursor === undefined) return true;
    if (deps.shouldStop()) return false;
    cursor = listing.nextCursor;
    listing = undefined;
  }
}

/** A creation whose outcome is unknown; its ids are kept so a retry replays the same command. */
export class AgentSessionProjectCreateInterrupted extends Error {
  constructor() {
    super("Adding the project was interrupted.");
  }
}

/**
 * Remembers the project id and command id each folder's creation used, so retrying after a lost
 * response replays the same command instead of creating a second project.
 */
export function createAgentSessionProjectEnsurer(input: {
  readonly findProjectId: (path: string) => ProjectId | null;
  readonly newIds: () => { readonly projectId: ProjectId; readonly commandId: CommandId };
  /** Rejects with the reason, or with `AgentSessionProjectCreateInterrupted` to keep the ids. */
  readonly createProject: (attempt: {
    readonly projectId: ProjectId;
    readonly commandId: CommandId;
    readonly folder: AgentSessionImportFolder;
  }) => Promise<void>;
}) {
  const attempts = new Map<
    string,
    { readonly projectId: ProjectId; readonly commandId: CommandId }
  >();
  const created = new Map<string, ProjectId>();
  return async (folder: AgentSessionImportFolder): Promise<ProjectId> => {
    const known = folder.projectId ?? created.get(folder.path) ?? input.findProjectId(folder.path);
    if (known !== null) return known;
    let attempt = attempts.get(folder.path);
    if (attempt === undefined) {
      attempt = input.newIds();
      attempts.set(folder.path, attempt);
    }
    try {
      await input.createProject({ ...attempt, folder });
    } catch (error) {
      if (!(error instanceof AgentSessionProjectCreateInterrupted)) attempts.delete(folder.path);
      throw error;
    }
    created.set(folder.path, attempt.projectId);
    return attempt.projectId;
  };
}
