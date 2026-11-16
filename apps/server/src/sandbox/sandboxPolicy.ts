// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import {
  defaultSandboxPaths,
  type ProjectSandboxOverride,
  type SandboxPlatform,
  type SandboxSettings,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as Schema from "effect/Schema";

export const MAX_SANDBOX_REASON_LENGTH = 2_000;

/** The OS sandbox cannot run here, with the tool's own words when it ran and failed. */
export class SandboxUnavailableError extends Schema.TaggedError<SandboxUnavailableError>()(
  "SandboxUnavailableError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `The filesystem sandbox is unavailable: ${this.reason}`;
  }
}

export type SandboxAvailability =
  | { readonly _tag: "Available"; readonly command: string }
  | { readonly _tag: "Unavailable"; readonly reason: string };

export interface SandboxedCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

export type SandboxAccess = "read-write" | "read-only" | "hidden";
export type SandboxPathKind = "directory" | "file" | "socket" | "symlink";

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
  | "docker"
  | "git-config"
  | "server"
  | "multiplexer";

export interface SandboxPolicyEntry {
  readonly path: string;
  readonly access: SandboxAccess;
  readonly kind: SandboxPathKind;
  readonly source: SandboxEntrySource;
  /** For a symlink entry, its target as written, so the link resolves as it does outside. */
  readonly linkTarget?: string;
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
  /** The provider's own state and install, such as `~/.claude` and `~/.claude.json`. */
  readonly providerPaths: ReadonlyArray<{
    readonly path: string;
    readonly access: "read-write" | "read-only";
  }>;
  readonly attachmentsDir: string;
  /** What the server hands agents from under its base dir, such as device launchers; read-only. */
  readonly serverPaths: ReadonlyArray<string>;
  readonly baseDir: string;
  readonly worktreesDir: string;
  readonly pathEnv: string | undefined;
  readonly tmpDir: string | undefined;
  /** macOS `getconf DARWIN_USER_CACHE_DIR`, which system frameworks write to. */
  readonly darwinUserCacheDir?: string | undefined;
  /** macOS `getconf DARWIN_USER_TEMP_DIR`, where the system screen keeps its sockets. */
  readonly darwinUserTempDir?: string | undefined;
  /** git's `core.excludesfile`, already home-expanded. */
  readonly gitExcludesFile?: string | undefined;
  readonly sshAuthSock: string | undefined;
  /** The user's name and tmux and screen socket settings, whose sockets stay hidden. */
  readonly userName?: string | undefined;
  readonly tmuxTmpDir?: string | undefined;
  readonly screenDir?: string | undefined;
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
  /** Every symlink resolving `path` passes through, at its real location, with its raw target. */
  readonly links?: (
    path: string,
  ) => ReadonlyArray<{ readonly path: string; readonly target: string }>;
}

interface Candidate {
  readonly path: string;
  readonly access: SandboxAccess;
  readonly source: SandboxEntrySource;
  readonly required: boolean;
  /** Exposed only when it still resolves to a socket. */
  readonly socket?: true;
  /** Exposed only when it resolves to a directory in a temp location. */
  readonly tmpDir?: true;
}

// A swapped TMPDIR must not turn into a grant elsewhere.
const TEMP_ROOTS = ["/tmp", "/var/tmp", "/private/tmp", "/private/var/tmp", "/private/var/folders"];

/**
 * A process that reaches a tmux or screen server runs commands outside the sandbox, and
 * `connect()` works through a read-only bind, so their default socket dirs stay hidden.
 */
function multiplexerSocketDirs(input: SandboxPolicyInput): ReadonlyArray<string> {
  const tmpRoot = input.platform === "darwin" ? "/private/tmp" : "/tmp";
  const user = input.userName;
  return [
    NodePath.posix.join(input.tmuxTmpDir ?? tmpRoot, `tmux-${input.uid}`),
    ...(input.screenDir === undefined ? [] : [input.screenDir]),
    ...(user === undefined
      ? []
      : input.platform === "linux"
        ? [`/run/screen/S-${user}`, `/var/run/screen/S-${user}`]
        : [`${tmpRoot}/.screen`, `${tmpRoot}/screens/S-${user}`]),
    ...(input.platform === "darwin" && input.darwinUserTempDir !== undefined
      ? [NodePath.posix.join(input.darwinUserTempDir, ".screen")]
      : []),
  ];
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
    : [
        "/var/run/docker.sock",
        NodePath.posix.join(input.home, ".docker/run/docker.sock"),
        NodePath.posix.join(input.home, ".orbstack/run/docker.sock"),
      ];
}

/**
 * On Linux a Docker socket created or recreated after launch is reachable at its path, so the
 * directories Docker Desktop and similar tools keep sockets in are hidden whole when they exist.
 */
function dockerSocketDirs(input: SandboxPolicyInput): ReadonlyArray<string> {
  return input.platform === "linux"
    ? [
        NodePath.posix.join(input.home, ".docker/run"),
        NodePath.posix.join(input.home, ".docker/desktop"),
      ]
    : [];
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
    ...(input.tmpDir === undefined
      ? []
      : [{ ...candidate(input.tmpDir, "read-write", "temp"), tmpDir: true as const }]),
    ...(input.darwinUserCacheDir === undefined
      ? []
      : [candidate(input.darwinUserCacheDir, "read-write", "temp")]),
    ...input.providerPaths.map((provider) => candidate(provider.path, provider.access, "provider")),
    ...input.settings.readWritePaths.map((path) =>
      candidate(userPath(path, input.home), "read-write", "user-read-write"),
    ),
    ...input.settings.readOnlyPaths.map((path) =>
      candidate(userPath(path, input.home), "read-only", "user-read-only"),
    ),
    ...homePathEntries.map((path) => candidate(path, "read-only", "path")),
    candidate(input.attachmentsDir, "read-only", "attachments"),
    ...input.serverPaths.map((path) => candidate(path, "read-only", "server")),
    // git exits on EPERM (macOS hidden paths) for its global config, so it stays readable.
    ...[
      NodePath.posix.join(input.home, ".gitconfig"),
      NodePath.posix.join(input.home, ".config/git"),
      ...(input.gitExcludesFile === undefined ? [] : [input.gitExcludesFile]),
    ].map((path) => candidate(path, "read-only", "git-config")),
    ...(input.sshAuthSock === undefined || input.sshAuthSock.length === 0
      ? []
      : [
          {
            ...candidate(
              input.sshAuthSock,
              input.settings.allowSshAgent ? "read-write" : "hidden",
              "ssh-agent",
            ),
            socket: true as const,
          },
        ]),
    ...dockerSocketPaths(input).map((path) => ({
      ...candidate(path, input.settings.allowDocker ? "read-write" : "hidden", "docker"),
      socket: true as const,
    })),
    ...(input.settings.allowDocker
      ? []
      : dockerSocketDirs(input).map((path) => candidate(path, "hidden", "docker"))),
    ...multiplexerSocketDirs(input).map((path) => candidate(path, "hidden", "multiplexer")),
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

/** `path` re-rooted at the real path of its deepest known ancestor, if any ancestor is known. */
function realMissingPath(path: string, facts: SandboxPathFacts): string | undefined {
  for (let parent = NodePath.posix.dirname(path); parent !== "/";) {
    const fact = facts.stat(parent);
    if (fact !== undefined) return fact.realPath + path.slice(parent.length);
    parent = NodePath.posix.dirname(parent);
  }
  return undefined;
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
  "git-config",
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
  // A listed path reached through a symlink must resolve inside as it does outside.
  const links = new Map<string, SandboxPolicyEntry>();
  const keepLinks = (candidate: Candidate) => {
    for (const link of facts.links?.(candidate.path) ?? []) {
      links.set(link.path, {
        path: link.path,
        access: "read-only",
        kind: "symlink",
        source: candidate.source,
        linkTarget: link.target,
      });
    }
  };

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
      // Seatbelt can deny a path before it exists, so a Docker socket or multiplexer socket dir
      // created after launch stays masked. bwrap cannot mask a missing path.
      if (
        input.platform === "darwin" &&
        (candidate.source === "docker" || candidate.source === "multiplexer") &&
        candidate.access === "hidden"
      ) {
        const path = realMissingPath(candidate.path, facts);
        if (path !== undefined && !byPath.has(path)) {
          byPath.set(path, {
            path,
            access: "hidden",
            kind: candidate.source === "docker" ? "socket" : "directory",
            source: candidate.source,
          });
        }
      }
      continue;
    }
    const path = fact.realPath;
    const reject = (reason: string) => rejected.push({ path, source: candidate.source, reason });

    if (candidate.socket === true && candidate.access !== "hidden" && fact.kind !== "socket") {
      reject("Not a socket, so it is not exposed.");
      continue;
    }
    if (
      candidate.tmpDir === true &&
      (fact.kind !== "directory" || !TEMP_ROOTS.some((root) => isWithin(path, root)))
    ) {
      reject("TMPDIR is not a directory in a temp location; only the default temp dirs apply.");
      continue;
    }

    if (USER_SOURCES.has(candidate.source)) {
      if (candidate.source === "path" && !isWithin(path, realHome)) {
        keepLinks(candidate);
        continue;
      }
      if (isWithin(realHome, path)) {
        reject("Exposes the whole home directory.");
        continue;
      }
      const hidden = mandatoryHidden.find(
        (root) =>
          isWithin(path, root) &&
          // Sockets are the runtime-dir paths the settings may expose.
          !(fact.kind === "socket" && root !== realBase),
      );
      if (hidden !== undefined) {
        reject(`Inside ${hidden}, which always stays hidden.`);
        continue;
      }
    }

    if (candidate.source === "server" && isWithin(realHome, path)) {
      reject("Exposes the whole home directory.");
      continue;
    }

    if (WORKSPACE_SOURCES.has(candidate.source)) {
      if (isWithin(realHome, path)) {
        return refuse(`${candidate.source} ${path} contains the whole home directory.`);
      }
      for (const root of mandatoryHidden) {
        if (isWithin(root, path)) {
          return refuse(`${candidate.source} ${path} contains ${root}, which always stays hidden.`);
        }
        // A provider's own state may live in the server's state dir, such as a managed home.
        const carvedOut =
          root === realBase && (isWithin(path, realWorktrees) || candidate.source === "provider");
        if (isWithin(path, root) && !carvedOut) {
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
    if (candidate.access !== "hidden") keepLinks(candidate);
    const existing = byPath.get(path);
    if (
      existing === undefined ||
      ACCESS_PRECEDENCE[entry.access] > ACCESS_PRECEDENCE[existing.access]
    ) {
      byPath.set(path, entry);
    }
  }

  const sorted = [...byPath.values(), ...links.values()].toSorted(
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
    // A link outside a hidden directory is already there as it is outside the sandbox.
    const redundant =
      entry.kind === "symlink"
        ? parentAccess !== "hidden"
        : entry.access === "hidden"
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
