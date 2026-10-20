import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AgentSessionListItem,
  type AgentSessionProjectCandidate,
  CommandId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  AgentSessionProjectCreateInterrupted,
  EMPTY_AGENT_SESSION_IMPORT_PROGRESS,
  agentSessionImportRetryPlan,
  agentSessionKey,
  applyAgentSessionImportEvent,
  createAgentSessionProjectEnsurer,
  groupAgentSessionProjects,
  runAgentSessionHistoryImport,
  summarizeAgentSessionImport,
  toggleAgentSessionSelection,
  type AgentSessionHistoryImportDeps,
  type AgentSessionImportFolder,
  type AgentSessionImportProgress,
} from "./agentSessionHistoryImport.ts";

const nowMs = Date.parse("2026-10-13T12:00:00.000Z");

function candidate(
  path: string,
  overrides: Partial<AgentSessionProjectCandidate> = {},
): AgentSessionProjectCandidate {
  return {
    title: path.split("/").at(-1) ?? path,
    path,
    sources: ["codex"],
    threadCount: 3,
    lastActiveAt: "2026-08-20T12:00:00.000Z",
    alreadyImported: false,
    git: { remoteKey: null, repository: null },
    ...overrides,
  };
}

const github = (repository: string) => ({
  remoteKey: `github.com/${repository.toLowerCase()}`,
  repository,
});

function session(id: string, overrides: Partial<AgentSessionListItem> = {}): AgentSessionListItem {
  return {
    provider: "codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerSessionId: id,
    title: id,
    updatedAt: "2026-10-13T10:00:00.000Z",
    importedThreadId: null,
    ...overrides,
  };
}

function folder(
  path: string,
  overrides: Partial<AgentSessionImportFolder> = {},
): AgentSessionImportFolder {
  return { path, title: path, projectId: null, selection: "all", ...overrides };
}

/** Runs a plan against scripted deps and returns the progress and the calls it made. */
async function runPlan(
  plan: ReadonlyArray<AgentSessionImportFolder>,
  overrides: Partial<AgentSessionHistoryImportDeps> = {},
) {
  let progress: AgentSessionImportProgress = EMPTY_AGENT_SESSION_IMPORT_PROGRESS;
  const imports: Array<string> = [];
  await runAgentSessionHistoryImport(plan, {
    nowMs: () => nowMs,
    listSessions: async () => [],
    ensureProject: async (target) => ProjectId.make(`project:${target.path}`),
    importSession: async (projectId, item) => {
      imports.push(`${projectId}/${item.providerSessionId}`);
      return { threadId: ThreadId.make(`thread:${item.providerSessionId}`), imported: true };
    },
    shouldStop: () => false,
    onEvent: (event) => {
      progress = applyAgentSessionImportEvent(progress, event);
    },
    ...overrides,
  });
  return { progress, imports };
}

function statuses(progress: AgentSessionImportProgress) {
  return Object.fromEntries(
    [...progress.sessions.values()].map(({ session: item, result }) => [
      item.providerSessionId,
      result.status === "failed" ? `failed: ${result.reason}` : result.status,
    ]),
  );
}

describe("groupAgentSessionProjects", () => {
  it("groups clones by origin, keeps local repos separate, and folds non-git folders away", () => {
    const main = candidate("/code/t3code", {
      git: github("pingdotgg/t3code"),
      threadCount: 79,
      lastActiveAt: "2026-08-21T12:00:00.000Z",
    });
    const clone = candidate("/code/clones/t3code-2", {
      git: github("pingdotgg/t3code"),
      threadCount: 13,
      lastActiveAt: "2026-08-10T12:00:00.000Z",
    });
    const older = candidate("/code/fleet", {
      git: github("t3dotgg/fleet"),
      threadCount: 295,
      lastActiveAt: "2026-08-22T00:00:00.000Z",
    });
    const local = candidate("/code/scratch-repo", { title: "scratch-repo" });
    const folder = candidate("/tmp/notes", { git: null });

    const grouped = groupAgentSessionProjects([main, clone, older, local, folder]);

    expect(grouped.other).toEqual([folder]);
    expect(
      grouped.repositories.map((group) => ({
        label: group.label,
        paths: group.candidates.map((item) => item.path),
        threadCount: group.threadCount,
        lastActiveAt: group.lastActiveAt,
      })),
    ).toEqual([
      {
        label: "t3dotgg/fleet",
        paths: ["/code/fleet"],
        threadCount: 295,
        lastActiveAt: "2026-08-22T00:00:00.000Z",
      },
      {
        label: "pingdotgg/t3code",
        paths: ["/code/t3code", "/code/clones/t3code-2"],
        threadCount: 92,
        lastActiveAt: "2026-08-21T12:00:00.000Z",
      },
      {
        label: "scratch-repo",
        paths: ["/code/scratch-repo"],
        threadCount: 3,
        lastActiveAt: "2026-08-20T12:00:00.000Z",
      },
    ]);
  });

  it("lists candidates without git identity as standalone repositories", () => {
    const { git: _git, ...legacy } = candidate("/code/legacy", { title: "legacy" });

    const grouped = groupAgentSessionProjects([legacy]);

    expect(grouped.other).toEqual([]);
    expect(grouped.repositories.map((group) => [group.label, group.repository])).toEqual([
      ["legacy", null],
    ]);
  });
});

describe("toggleAgentSessionSelection", () => {
  const sessions = [
    session("a"),
    session("b"),
    session("open", { updatedAt: "2026-10-13T11:59:00.000Z" }),
    session("done", { importedThreadId: ThreadId.make("thread:done") }),
  ];

  it("turns a folder-wide selection into the defaults minus the unchecked session", () => {
    const next = toggleAgentSessionSelection({
      selection: "all",
      sessions,
      key: agentSessionKey(sessions[0]!),
      checked: false,
      nowMs,
    });
    expect(next).toEqual(new Set([agentSessionKey(sessions[1]!)]));
  });

  it("adds a session the defaults leave out and clears the folder when nothing is left", () => {
    const withOpen = toggleAgentSessionSelection({
      selection: undefined,
      sessions,
      key: agentSessionKey(sessions[2]!),
      checked: true,
      nowMs,
    });
    expect(withOpen).toEqual(new Set([agentSessionKey(sessions[2]!)]));
    expect(
      toggleAgentSessionSelection({
        selection: withOpen,
        sessions,
        key: agentSessionKey(sessions[2]!),
        checked: false,
        nowMs,
      }),
    ).toBeUndefined();
  });
});

describe("runAgentSessionHistoryImport", () => {
  it("imports a folder's default selection and skips sessions that already have a thread", async () => {
    const { progress, imports } = await runPlan([folder("/code/app")], {
      listSessions: async () => [
        session("new"),
        session("open", { updatedAt: "2026-10-13T11:58:00.000Z" }),
        session("done", { importedThreadId: ThreadId.make("thread:done") }),
      ],
    });

    expect(imports).toEqual(["project:/code/app/new"]);
    expect(statuses(progress)).toEqual({ new: "imported", done: "already-imported" });
    expect(summarizeAgentSessionImport(progress)).toEqual({
      imported: 1,
      alreadyImported: 1,
      failed: 0,
    });
  });

  it("reports each failure with its reason and keeps going", async () => {
    const { progress, imports } = await runPlan(
      [
        folder("/code/unlisted"),
        folder("/code/no-project", { sessions: [session("orphan")] }),
        folder("/code/app", { sessions: [session("broken"), session("fine")] }),
      ],
      {
        listSessions: async () => {
          throw new Error("Scan failed.");
        },
        ensureProject: async (target) => {
          if (target.path === "/code/no-project") throw new Error("Folder is gone.");
          return ProjectId.make("project:app");
        },
        importSession: async (projectId, item) => {
          if (item.providerSessionId === "broken") throw new Error("Transcript unreadable.");
          return {
            threadId: ThreadId.make(`${projectId}:${item.providerSessionId}`),
            imported: true,
          };
        },
      },
    );

    expect(imports).toEqual([]);
    expect(statuses(progress)).toEqual({
      orphan: "failed: Folder is gone.",
      broken: "failed: Transcript unreadable.",
      fine: "imported",
    });
    expect(
      [...progress.failedFolders.entries()].map(([path, { reason }]) => [path, reason]),
    ).toEqual([["/code/unlisted", "Scan failed."]]);
    expect(summarizeAgentSessionImport(progress).failed).toBe(3);
  });

  it("stops after the current session and keeps what finished", async () => {
    let stop = false;
    const imports: Array<string> = [];
    const { progress } = await runPlan(
      [folder("/code/app", { sessions: [session("one"), session("two")] }), folder("/code/next")],
      {
        importSession: async (projectId, item) => {
          imports.push(item.providerSessionId);
          stop = true;
          return {
            threadId: ThreadId.make(`${projectId}:${item.providerSessionId}`),
            imported: true,
          };
        },
        listSessions: async () => {
          throw new Error("Should not list after stopping.");
        },
        shouldStop: () => stop,
      },
    );

    expect(imports).toEqual(["one"]);
    expect(statuses(progress)).toEqual({ one: "imported" });
    expect(progress.failedFolders.size).toBe(0);
  });

  it("retries only what failed, and a successful retry clears the failure", async () => {
    let attempt = 0;
    const plan = [
      folder("/code/unlisted"),
      folder("/code/app", { sessions: [session("broken"), session("fine")] }),
    ];
    const first = await runPlan(plan, {
      listSessions: async () => {
        throw new Error("Scan failed.");
      },
      importSession: async (projectId, item) => {
        if (item.providerSessionId === "broken") throw new Error("Busy.");
        return {
          threadId: ThreadId.make(`${projectId}:${item.providerSessionId}`),
          imported: true,
        };
      },
    });

    const retry = agentSessionImportRetryPlan(first.progress);
    expect(
      retry.map((item) => [item.path, item.sessions?.map((s) => s.providerSessionId)]),
    ).toEqual([
      ["/code/unlisted", undefined],
      ["/code/app", ["broken"]],
    ]);

    let progress = first.progress;
    await runAgentSessionHistoryImport(retry, {
      nowMs: () => nowMs,
      listSessions: async () => [session("late")],
      ensureProject: async (target) => ProjectId.make(`project:${target.path}`),
      importSession: async (projectId, item) => {
        attempt += 1;
        return {
          threadId: ThreadId.make(`${projectId}:${item.providerSessionId}`),
          imported: true,
        };
      },
      shouldStop: () => false,
      onEvent: (event) => {
        progress = applyAgentSessionImportEvent(progress, event);
      },
    });

    expect(attempt).toBe(2);
    expect(statuses(progress)).toEqual({ broken: "imported", fine: "imported", late: "imported" });
    expect(progress.failedFolders.size).toBe(0);
    expect(agentSessionImportRetryPlan(progress)).toEqual([]);
  });

  it("clears a folder's listing failure when a retry lists nothing to import", async () => {
    const first = await runPlan([folder("/code/unlisted")], {
      listSessions: async () => {
        throw new Error("Scan failed.");
      },
    });
    expect(agentSessionImportRetryPlan(first.progress)).toHaveLength(1);

    let progress = first.progress;
    await runPlan(agentSessionImportRetryPlan(first.progress), {
      listSessions: async () => [
        session("done", { importedThreadId: ThreadId.make("thread:done") }),
      ],
      onEvent: (event) => {
        progress = applyAgentSessionImportEvent(progress, event);
      },
    });

    expect(progress.failedFolders.size).toBe(0);
    expect(summarizeAgentSessionImport(progress)).toEqual({
      imported: 0,
      alreadyImported: 1,
      failed: 0,
    });
    expect(agentSessionImportRetryPlan(progress)).toEqual([]);
  });
});

describe("createAgentSessionProjectEnsurer", () => {
  function makeEnsurer(createProject: (attempt: { projectId: ProjectId }) => Promise<void>) {
    let next = 0;
    const created: Array<ProjectId> = [];
    const ensure = createAgentSessionProjectEnsurer({
      findProjectId: (path) => (path === "/code/known" ? ProjectId.make("known") : null),
      newIds: () => {
        next += 1;
        return {
          projectId: ProjectId.make(`project-${next}`),
          commandId: CommandId.make(`command-${next}`),
        };
      },
      createProject: async (attempt) => {
        created.push(attempt.projectId);
        await createProject(attempt);
      },
    });
    return { ensure, created };
  }

  it("uses an existing project and creates a missing one once", async () => {
    const { ensure, created } = makeEnsurer(async () => {});

    expect(await ensure(folder("/code/known"))).toBe("known");
    expect(await ensure(folder("/code/app", { projectId: ProjectId.make("scanned") }))).toBe(
      "scanned",
    );
    expect(await ensure(folder("/code/new"))).toBe("project-1");
    expect(await ensure(folder("/code/new"))).toBe("project-1");
    expect(created).toEqual(["project-1"]);
  });

  it("replays the same ids after an interruption and fresh ids after a failure", async () => {
    const outcomes: Array<() => Promise<void>> = [
      async () => {
        throw new AgentSessionProjectCreateInterrupted();
      },
      async () => {
        throw new Error("Rejected.");
      },
      async () => {},
    ];
    const { ensure, created } = makeEnsurer(() => outcomes.shift()!());

    await expect(ensure(folder("/code/new"))).rejects.toThrow("interrupted");
    await expect(ensure(folder("/code/new"))).rejects.toThrow("Rejected.");
    expect(await ensure(folder("/code/new"))).toBe("project-2");
    expect(created).toEqual(["project-1", "project-1", "project-2"]);
  });
});
