// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import {
  defaultSandboxPaths,
  type ProjectSandboxOverride,
  type SandboxPlatform,
  type SandboxSettings,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";

export type SandboxAccess = "read-write" | "read-only" | "hidden";
export type SandboxPathKind = "directory" | "file";

export type SandboxEntrySource =
  | "cwd"
  | "git-common-dir"
  | "additional-directory"
  | "temp"
  | "provider"
  | "user-read-write"
  | "user-read-only"
  | "path"
  | "attachments"
  | "home"
  | "kinako-base-dir"
  | "runtime-dir"
  | "ssh-agent"
  | "docker";

export interface SandboxPolicyEntry {
  readonly path: string;
  readonly access: SandboxAccess;
  readonly kind: SandboxPathKind;
  readonly source: SandboxEntrySource;
}

export interface SandboxRejectedEntry {
  readonly path: string;
  readonly source: SandboxEntrySource;
  readonly reason: string;
}

/**
 * One thread's sandbox: real, existing paths ordered so each entry comes after every entry that
 * contains it. Anything not listed keeps the root's access: read-only outside hidden entries.
 */
export interface SandboxPolicy {
  readonly platform: SandboxPlatform;
  readonly cwd: string;
  readonly entries: ReadonlyArray<SandboxPolicyEntry>;
  readonly rejected: ReadonlyArray<SandboxRejectedEntry>;
}

export type SandboxPolicyResolution =
  | { readonly _tag: "Resolved"; readonly policy: SandboxPolicy }
  | { readonly _tag: "Refused"; readonly reason: string };

export interface EffectiveSandboxSettings {
  readonly readWritePaths: ReadonlyArray<string>;
  readonly readOnlyPaths: ReadonlyArray<string>;
  readonly allowDocker: boolean;
  readonly allowSshAgent: boolean;
}

export interface SandboxPolicyInput {
  readonly platform: SandboxPlatform;
  readonly home: string;
  readonly uid: number;
  readonly cwd: string;
  readonly gitCommonDirs: ReadonlyArray<string>;
  readonly additionalDirectories: ReadonlyArray<{
    readonly path: string;
    readonly access: "read-write" | "read-only";
  }>;
  /** Provider-owned state the agent writes, such as `~/.claude` and `~/.claude.json`. */
  readonly providerPaths: ReadonlyArray<string>;
  readonly attachmentsDir: string;
  readonly baseDir: string;
  readonly worktreesDir: string;
  readonly pathEnv: string | undefined;
  readonly tmpDir: string | undefined;
  readonly sshAuthSock: string | undefined;
  readonly settings: EffectiveSandboxSettings;
}

export interface SandboxPathFact {
  readonly realPath: string;
  readonly kind: SandboxPathKind;
}

/** What the filesystem says about candidate paths; missing paths are undefined. */
export interface SandboxPathFacts {
  readonly stat: (path: string) => SandboxPathFact | undefined;
  readonly list: (directory: string) => ReadonlyArray<string>;
}

interface Candidate {
  readonly path: string;
  readonly access: SandboxAccess;
  readonly source: SandboxEntrySource;
  readonly required: boolean;
}

/** The environment's lists, or the platform defaults for null ones, plus what the project adds. */
export function effectiveSandboxSettings(
  settings: SandboxSettings,
  project: ProjectSandboxOverride | undefined,
  platform: SandboxPlatform,
): EffectiveSandboxSettings {
  const defaults = defaultSandboxPaths(platform);
  return {
    readWritePaths: [
      ...(settings.readWritePaths ?? defaults.readWritePaths),
      ...(project?.readWritePaths ?? []),
    ],
    readOnlyPaths: [
      ...(settings.readOnlyPaths ?? defaults.readOnlyPaths),
      ...(project?.readOnlyPaths ?? []),
    ],
    allowDocker: settings.allowDocker,
    allowSshAgent: settings.allowSshAgent,
  };
}

const runtimeDirFor = (input: Pick<SandboxPolicyInput, "platform" | "uid">) =>
  input.platform === "linux" ? `/run/user/${input.uid}` : undefined;

function dockerSocketPaths(input: SandboxPolicyInput): ReadonlyArray<string> {
  const runtimeDir = runtimeDirFor(input);
  return input.platform === "linux"
    ? ["/run/docker.sock", "/var/run/docker.sock", `${runtimeDir}/docker.sock`]
    : ["/var/run/docker.sock", NodePath.posix.join(input.home, ".docker/run/docker.sock")];
}

const userPath = (raw: string, home: string) => expandHomePath(raw.trim(), home);

/** Every path the policy may name, before the filesystem is consulted. */
export function sandboxCandidates(input: SandboxPolicyInput): ReadonlyArray<Candidate> {
  const candidate = (
    path: string,
    access: SandboxAccess,
    source: SandboxEntrySource,
    required = false,
  ): Candidate => ({ path, access, source, required });
  const runtimeDir = runtimeDirFor(input);
  const homePathEntries = (input.pathEnv ?? "")
    .split(":")
    .filter((entry) => NodePath.posix.isAbsolute(entry));
  return [
    candidate(input.home, "hidden", "home", true),
    candidate(input.baseDir, "hidden", "kinako-base-dir"),
    ...(runtimeDir === undefined ? [] : [candidate(runtimeDir, "hidden", "runtime-dir")]),
    candidate(input.cwd, "read-write", "cwd", true),
    ...input.gitCommonDirs.map((path) => candidate(path, "read-write", "git-common-dir")),
    ...input.additionalDirectories.map((directory) =>
      candidate(directory.path, directory.access, "additional-directory"),
    ),
    candidate("/tmp", "read-write", "temp"),
    ...(input.tmpDir === undefined ? [] : [candidate(input.tmpDir, "read-write", "temp")]),
    ...input.providerPaths.map((path) => candidate(path, "read-write", "provider")),
    ...input.settings.readWritePaths.map((path) =>
      candidate(userPath(path, input.home), "read-write", "user-read-write"),
    ),
    ...input.settings.readOnlyPaths.map((path) =>
      candidate(userPath(path, input.home), "read-only", "user-read-only"),
    ),
    ...homePathEntries.map((path) => candidate(path, "read-only", "path")),
    candidate(input.attachmentsDir, "read-only", "attachments"),
    ...(input.sshAuthSock === undefined || input.sshAuthSock.length === 0
      ? []
      : [
          candidate(
            input.sshAuthSock,
            input.settings.allowSshAgent ? "read-write" : "hidden",
            "ssh-agent",
          ),
        ]),
    ...dockerSocketPaths(input).map((path) =>
      candidate(path, input.settings.allowDocker ? "read-write" : "hidden", "docker"),
    ),
    ...(input.settings.allowDocker
      ? [candidate(NodePath.posix.join(input.home, ".docker"), "read-write", "docker")]
      : []),
  ];
}

/** Directories whose listing expands a wildcard candidate. */
export function sandboxWildcardDirectories(
  candidates: ReadonlyArray<{ readonly path: string }>,
): ReadonlyArray<string> {
  return candidates.flatMap((candidate) =>
    wildcardParts(candidate.path) === undefined ? [] : [NodePath.posix.dirname(candidate.path)],
  );
}

function wildcardParts(path: string): { directory: string; pattern: RegExp } | undefined {
  const name = NodePath.posix.basename(path);
  if (!name.includes("*")) return undefined;
  const escaped = name.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return {
    directory: NodePath.posix.dirname(path),
    pattern: new RegExp(`^${escaped.join("[^/]*")}$`),
  };
}

const isWithin = (path: string, root: string) =>
  path === root || root === "/" || path.startsWith(`${root}/`);

const depth = (path: string) => (path === "/" ? 0 : path.split("/").length - 1);

const ACCESS_PRECEDENCE: Record<SandboxAccess, number> = {
  hidden: 2,
  "read-write": 1,
  "read-only": 0,
};

const USER_SOURCES: ReadonlySet<SandboxEntrySource> = new Set([
  "user-read-write",
  "user-read-only",
  "temp",
  "path",
  "ssh-agent",
]);
const WORKSPACE_SOURCES: ReadonlySet<SandboxEntrySource> = new Set([
  "cwd",
  "git-common-dir",
  "additional-directory",
  "provider",
]);

export function resolveSandboxPolicy(
  input: SandboxPolicyInput,
  facts: SandboxPathFacts,
): SandboxPolicyResolution {
  const refuse = (reason: string): SandboxPolicyResolution => ({ _tag: "Refused", reason });
  const real = (path: string) => facts.stat(path)?.realPath ?? NodePath.posix.normalize(path);

  const home = facts.stat(input.home);
  if (home === undefined || home.kind !== "directory") {
    return refuse(`Home directory ${input.home} does not exist.`);
  }
  const realHome = home.realPath;
  const realBase = real(input.baseDir);
  const realWorktrees = real(input.worktreesDir);
  const runtimeDir = runtimeDirFor(input);
  const mandatoryHidden = [realBase, ...(runtimeDir === undefined ? [] : [real(runtimeDir)])];

  const rejected: Array<SandboxRejectedEntry> = [];
  const byPath = new Map<string, SandboxPolicyEntry>();

  const expanded = sandboxCandidates(input).flatMap((candidate): ReadonlyArray<Candidate> => {
    if (!NodePath.posix.isAbsolute(candidate.path)) {
      rejected.push({
        path: candidate.path,
        source: candidate.source,
        reason: "Not an absolute or home-relative path.",
      });
      return [];
    }
    const wildcard = wildcardParts(candidate.path);
    if (wildcard === undefined) {
      if (NodePath.posix.dirname(candidate.path).includes("*")) {
        rejected.push({
          path: candidate.path,
          source: candidate.source,
          reason: "Only the last path segment may hold a wildcard.",
        });
        return [];
      }
      return [candidate];
    }
    return facts
      .list(wildcard.directory)
      .filter((name) => wildcard.pattern.test(name))
      .map((name) => ({
        ...candidate,
        path: NodePath.posix.join(wildcard.directory, name),
      }));
  });

  for (const candidate of expanded) {
    const fact = facts.stat(candidate.path);
    if (fact === undefined) {
      if (candidate.required)
        return refuse(`${candidate.source} ${candidate.path} does not exist.`);
      continue;
    }
    const path = fact.realPath;
    const reject = (reason: string) => rejected.push({ path, source: candidate.source, reason });

    if (USER_SOURCES.has(candidate.source)) {
      if (candidate.source === "path" && !isWithin(path, realHome)) continue;
      if (isWithin(realHome, path)) {
        reject("Exposes the whole home directory.");
        continue;
      }
      const hidden = mandatoryHidden.find(
        (root) =>
          isWithin(path, root) &&
          // The ssh-agent socket is the one runtime-dir path the settings may expose.
          !(candidate.source === "ssh-agent" && root !== realBase),
      );
      if (hidden !== undefined) {
        reject(`Inside ${hidden}, which always stays hidden.`);
        continue;
      }
    }

    if (WORKSPACE_SOURCES.has(candidate.source)) {
      if (isWithin(realHome, path)) {
        return refuse(`${candidate.source} ${path} contains the whole home directory.`);
      }
      for (const root of mandatoryHidden) {
        if (isWithin(root, path)) {
          return refuse(`${candidate.source} ${path} contains ${root}, which always stays hidden.`);
        }
        if (isWithin(path, root) && !(root === realBase && isWithin(path, realWorktrees))) {
          return refuse(
            `${candidate.source} ${path} is inside ${root}, which always stays hidden.`,
          );
        }
      }
    }

    const entry: SandboxPolicyEntry = {
      path,
      access: candidate.access,
      kind: fact.kind,
      source: candidate.source,
    };
    const existing = byPath.get(path);
    if (
      existing === undefined ||
      ACCESS_PRECEDENCE[entry.access] > ACCESS_PRECEDENCE[existing.access]
    ) {
      byPath.set(path, entry);
    }
  }

  const sorted = [...byPath.values()].toSorted(
    (left, right) =>
      depth(left.path) - depth(right.path) ||
      (left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
  );
  const kept: Array<SandboxPolicyEntry> = [];
  for (const entry of sorted) {
    const parent = kept
      .filter((candidate) => candidate.kind === "directory" && isWithin(entry.path, candidate.path))
      .at(-1);
    // The root is bound read-only, so it is the outermost ancestor of every entry.
    const parentAccess = parent?.access ?? "read-only";
    const redundant =
      entry.access === "hidden"
        ? parentAccess === "hidden"
        : entry.access === "read-write"
          ? parentAccess === "read-write"
          : parentAccess !== "hidden";
    if (!redundant) kept.push(entry);
  }

  return {
    _tag: "Resolved",
    policy: { platform: input.platform, cwd: real(input.cwd), entries: kept, rejected },
  };
}
