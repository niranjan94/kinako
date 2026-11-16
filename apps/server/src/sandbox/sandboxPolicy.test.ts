import { describe, expect, it } from "vite-plus/test";

import {
  effectiveSandboxSettings,
  resolveSandboxPolicy,
  type SandboxAccess,
  type SandboxPathKind,
  type SandboxPolicy,
  type SandboxPolicyInput,
} from "./sandboxPolicy.ts";

const HOME = "/home/user";

type FakeEntry = SandboxPathKind | { readonly link: string };

function fakeFacts(tree: Record<string, FakeEntry>) {
  const resolve = (path: string): string => {
    for (const [from, entry] of Object.entries(tree)) {
      if (typeof entry === "object" && (path === from || path.startsWith(`${from}/`))) {
        return resolve(entry.link + path.slice(from.length));
      }
    }
    return path;
  };
  return {
    stat: (path: string) => {
      const realPath = resolve(path);
      const kind = tree[realPath];
      return typeof kind === "string" ? { realPath, kind } : undefined;
    },
    list: (directory: string) =>
      Object.keys(tree)
        .filter((path) => path.startsWith(`${directory}/`))
        .map((path) => path.slice(directory.length + 1))
        .filter((name) => !name.includes("/")),
    links: (path: string) => {
      const found: Array<{ readonly path: string; readonly target: string }> = [];
      const pending = path.split("/").filter(Boolean);
      let resolved = "";
      for (let part = pending.shift(); part !== undefined; part = pending.shift()) {
        const next = `${resolved}/${part}`;
        const entry = tree[next];
        if (typeof entry !== "object") {
          resolved = next;
          continue;
        }
        found.push({ path: next, target: entry.link });
        pending.unshift(...entry.link.split("/").filter(Boolean));
        resolved = "";
      }
      return found;
    },
  };
}

const LINUX_TREE: Record<string, FakeEntry> = {
  "/home": "directory",
  [HOME]: "directory",
  [`${HOME}/.kinako/bin`]: "directory",
  [`${HOME}/code/app`]: "directory",
  [`${HOME}/code/app/.git`]: "directory",
  [`${HOME}/code/app-wt`]: "directory",
  [`${HOME}/code/other`]: "directory",
  [`${HOME}/.kinako`]: "directory",
  [`${HOME}/.kinako/worktrees`]: "directory",
  [`${HOME}/.kinako/worktrees/app/thread-1`]: "directory",
  [`${HOME}/.kinako/userdata`]: "directory",
  [`${HOME}/.kinako/userdata/attachments`]: "directory",
  [`${HOME}/.kinako/userdata/device`]: "directory",
  [`${HOME}/.kinako/tools`]: "directory",
  [`${HOME}/.kinako/userdata/providers/codex/work/shadow`]: "directory",
  [`${HOME}/.claude`]: "directory",
  [`${HOME}/.claude.json`]: "file",
  [`${HOME}/.cache`]: "directory",
  [`${HOME}/.cache/tool/bin`]: "directory",
  [`${HOME}/.local/share/pnpm`]: "directory",
  [`${HOME}/.local/share/pnpm/bin`]: "directory",
  [`${HOME}/.local/bin`]: "directory",
  [`${HOME}/.cargo`]: "directory",
  [`${HOME}/.cargo/bin`]: "directory",
  [`${HOME}/.cargo/registry`]: "directory",
  [`${HOME}/.cargo/credentials.toml`]: "file",
  [`${HOME}/.gitconfig`]: "file",
  [`${HOME}/.config/git`]: { link: `${HOME}/dotfiles/git` },
  [`${HOME}/dotfiles/git`]: "directory",
  [`${HOME}/.ssh`]: "directory",
  [`${HOME}/.ssh/config`]: "file",
  [`${HOME}/.ssh/known_hosts`]: "file",
  [`${HOME}/.ssh/id_ed25519`]: "file",
  [`${HOME}/.ssh/id_ed25519.pub`]: "file",
  [`${HOME}/.docker`]: "directory",
  [`${HOME}/.docker/desktop`]: "directory",
  [`${HOME}/.docker/run`]: "directory",
  "/tmp": "directory",
  "/tmp/tmux-1000": "directory",
  [`${HOME}/.fnm/aliases/default`]: { link: `${HOME}/.fnm/node-versions/v24` },
  [`${HOME}/.fnm/node-versions/v24/bin`]: "directory",
  [`${HOME}/.tools/bin`]: { link: "/opt/tools/bin" },
  "/opt/tools/bin": "directory",
  "/tmp/user-tmp": "directory",
  "/run/screen/S-user": "directory",
  [`${HOME}/.agent-dir`]: "directory",
  [`${HOME}/scratch`]: "directory",
  "/run/user/1000": "directory",
  "/run/user/1000/bus": "file",
  "/run/user/1000/keyring/ssh": "socket",
  "/run/user/1000/1password/agent.sock": "socket",
  "/run/docker.sock": "socket",
  "/var/run": { link: "/run" },
  "/srv/kinako": "directory",
  "/srv/kinako/worktrees/app/thread-2": "directory",
  "/srv/kinako/userdata/attachments": "directory",
};

const linuxInput = (overrides: Partial<SandboxPolicyInput> = {}): SandboxPolicyInput => ({
  platform: "linux",
  home: HOME,
  uid: 1000,
  cwd: `${HOME}/code/app`,
  gitCommonDirs: [`${HOME}/code/app/.git`],
  additionalDirectories: [],
  providerPaths: [
    { path: `${HOME}/.claude`, access: "read-write" },
    { path: `${HOME}/.claude.json`, access: "read-write" },
  ],
  serverPaths: [`${HOME}/.kinako/userdata/device`, `${HOME}/.kinako/tools`],
  attachmentsDir: `${HOME}/.kinako/userdata/attachments`,
  baseDir: `${HOME}/.kinako`,
  worktreesDir: `${HOME}/.kinako/worktrees`,
  pathEnv: [
    "/usr/bin",
    `${HOME}/.local/share/pnpm/bin`,
    `${HOME}/.cache/tool/bin`,
    `${HOME}/.cargo/bin`,
    `${HOME}/.kinako/bin`,
  ].join(":"),
  tmpDir: undefined,
  sshAuthSock: undefined,
  settings: effectiveSandboxSettings(
    { readWritePaths: null, readOnlyPaths: null, allowDocker: false, allowSshAgent: true },
    undefined,
    "linux",
  ),
  ...overrides,
});

/** The access a path ends up with: its deepest covering entry, else the read-only root. */
function accessOf(policy: SandboxPolicy, path: string): SandboxAccess {
  const covering = policy.entries.filter(
    (entry) => path === entry.path || path.startsWith(`${entry.path}/`),
  );
  return covering.at(-1)?.access ?? "read-only";
}

function resolved(input: SandboxPolicyInput, tree = LINUX_TREE): SandboxPolicy {
  const resolution = resolveSandboxPolicy(input, fakeFacts(tree));
  if (resolution._tag !== "Resolved") throw new Error(resolution.reason);
  return resolution.policy;
}

describe("resolveSandboxPolicy", () => {
  it.each<{
    readonly name: string;
    readonly input: SandboxPolicyInput;
    readonly access: ReadonlyArray<readonly [string, SandboxAccess]>;
  }>([
    {
      name: "project checkout",
      input: linuxInput(),
      access: [
        [`${HOME}/code/app/src/index.ts`, "read-write"],
        [`${HOME}/code/app/.git/hooks/pre-commit`, "read-write"],
        [`${HOME}/code/other`, "hidden"],
        [`${HOME}/.ssh/id_ed25519`, "hidden"],
        [`${HOME}/.ssh/id_ed25519.pub`, "read-only"],
        [`${HOME}/.ssh/config`, "read-only"],
        [`${HOME}/.ssh/known_hosts`, "read-write"],
        [`${HOME}/.gitconfig`, "read-only"],
        [`${HOME}/dotfiles/git/config`, "read-only"],
        [`${HOME}/.claude/settings.json`, "read-write"],
        [`${HOME}/.claude.json`, "read-write"],
        [`${HOME}/.kinako/userdata/settings.json`, "hidden"],
        [`${HOME}/.kinako/userdata/attachments/a.png`, "read-only"],
        [`${HOME}/.kinako/userdata/device/bin/agent-device`, "read-only"],
        [`${HOME}/.kinako/tools/agent-device/1.0/cli.js`, "read-only"],
        [`${HOME}/.kinako/userdata/secrets/key`, "hidden"],
        [`${HOME}/.kinako/userdata/logs/server.log`, "hidden"],
        [`${HOME}/.kinako/bin`, "hidden"],
        [`${HOME}/.cargo/bin/cargo`, "read-only"],
        [`${HOME}/.cargo/registry/index`, "read-write"],
        [`${HOME}/.cargo/credentials.toml`, "hidden"],
        [`${HOME}/.local/share/pnpm/bin/pnpm`, "read-write"],
        ["/usr/bin/git", "read-only"],
        ["/tmp/build", "read-write"],
        ["/run/user/1000/bus", "hidden"],
        ["/run/docker.sock", "hidden"],
        [`${HOME}/.docker/config.json`, "hidden"],
      ],
    },
    {
      name: "linked worktree",
      input: linuxInput({ cwd: `${HOME}/code/app-wt` }),
      access: [
        [`${HOME}/code/app-wt/src/index.ts`, "read-write"],
        [`${HOME}/code/app/.git/worktrees/app-wt/HEAD`, "read-write"],
        [`${HOME}/code/app/src/index.ts`, "hidden"],
      ],
    },
    {
      name: "worktree under the base dir",
      input: linuxInput({ cwd: `${HOME}/.kinako/worktrees/app/thread-1`, gitCommonDirs: [] }),
      access: [
        [`${HOME}/.kinako/worktrees/app/thread-1/file`, "read-write"],
        [`${HOME}/.kinako/worktrees/app/thread-2`, "hidden"],
        [`${HOME}/.kinako/userdata/statev2.sqlite`, "hidden"],
      ],
    },
    {
      name: "base dir outside home",
      input: linuxInput({
        cwd: "/srv/kinako/worktrees/app/thread-2",
        gitCommonDirs: [],
        baseDir: "/srv/kinako",
        worktreesDir: "/srv/kinako/worktrees",
        attachmentsDir: "/srv/kinako/userdata/attachments",
      }),
      access: [
        ["/srv/kinako/worktrees/app/thread-2/file", "read-write"],
        ["/srv/kinako/userdata/statev2.sqlite", "hidden"],
        ["/srv/kinako/userdata/attachments/a.png", "read-only"],
      ],
    },
    {
      name: "ssh agent and docker opted in",
      input: linuxInput({
        sshAuthSock: "/run/user/1000/keyring/ssh",
        settings: {
          ...linuxInput().settings,
          allowDocker: true,
        },
      }),
      access: [
        ["/run/user/1000/keyring/ssh", "read-write"],
        ["/run/user/1000/bus", "hidden"],
        ["/run/docker.sock", "read-write"],
        [`${HOME}/.docker/config.json`, "read-write"],
      ],
    },
    {
      name: "symlinked allowlist entries, a symlinked leaf and an intermediate link",
      input: linuxInput({
        pathEnv: [`${HOME}/.fnm/aliases/default/bin`, `${HOME}/.tools/bin`].join(":"),
        settings: { ...linuxInput().settings, readOnlyPaths: ["~/.config/git"] },
      }),
      access: [
        [`${HOME}/.config/git`, "read-only"],
        [`${HOME}/dotfiles/git/config`, "read-only"],
        [`${HOME}/.fnm/aliases/default`, "read-only"],
        [`${HOME}/.fnm/node-versions/v24/bin/node`, "read-only"],
        [`${HOME}/.fnm/node-versions/v24/lib`, "hidden"],
        [`${HOME}/.tools/bin`, "read-only"],
      ],
    },
    {
      name: "the user's tmux and screen sockets",
      input: linuxInput({ userName: "user" }),
      access: [
        ["/tmp/tmux-1000/default", "hidden"],
        ["/run/screen/S-user/1234.pts-0", "hidden"],
        ["/tmp/kinako-mux-1000-abc/default", "read-write"],
      ],
    },
    {
      name: "Docker socket directories hidden inside a listed ~/.docker",
      input: linuxInput({
        settings: { ...linuxInput().settings, readWritePaths: ["~/.docker"] },
      }),
      access: [
        [`${HOME}/.docker/config.json`, "read-write"],
        [`${HOME}/.docker/desktop/docker.sock`, "hidden"],
        [`${HOME}/.docker/run/docker.sock`, "hidden"],
      ],
    },
    {
      name: "a Cargo token file a list names",
      input: linuxInput({
        settings: {
          ...linuxInput().settings,
          readOnlyPaths: [...linuxInput().settings.readOnlyPaths, "~/.cargo/credentials.toml"],
        },
      }),
      access: [[`${HOME}/.cargo/credentials.toml`, "read-only"]],
    },
    {
      name: "Docker socket directories left alone when Docker is allowed",
      input: linuxInput({
        settings: { ...linuxInput().settings, readWritePaths: ["~/.docker"], allowDocker: true },
      }),
      access: [[`${HOME}/.docker/desktop/docker.sock`, "read-write"]],
    },
    {
      name: "a socket path that is a directory, and a TMPDIR outside temp",
      input: linuxInput({ sshAuthSock: `${HOME}/.agent-dir`, tmpDir: `${HOME}/scratch` }),
      access: [
        [`${HOME}/.agent-dir/key`, "hidden"],
        [`${HOME}/scratch/file`, "hidden"],
      ],
    },
    {
      name: "a TMPDIR inside the temp dir",
      input: linuxInput({ tmpDir: "/tmp/user-tmp" }),
      access: [["/tmp/user-tmp/file", "read-write"]],
    },
    {
      name: "a managed provider home inside the base dir",
      input: linuxInput({
        providerPaths: [
          { path: `${HOME}/.kinako/userdata/providers/codex/work/shadow`, access: "read-write" },
        ],
      }),
      access: [
        [`${HOME}/.kinako/userdata/providers/codex/work/shadow/auth.json`, "read-write"],
        [`${HOME}/.kinako/userdata/providers/codex/other`, "hidden"],
        [`${HOME}/.kinako/userdata/statev2.sqlite`, "hidden"],
      ],
    },
    {
      name: "ssh agent opted out",
      input: linuxInput({
        sshAuthSock: "/run/user/1000/keyring/ssh",
        settings: { ...linuxInput().settings, allowSshAgent: false },
      }),
      access: [["/run/user/1000/keyring/ssh", "hidden"]],
    },
    {
      name: "a listed agent socket in the runtime dir, and git config with empty lists",
      input: linuxInput({
        settings: {
          ...linuxInput().settings,
          readWritePaths: ["/run/user/1000/1password/agent.sock"],
          readOnlyPaths: [],
        },
      }),
      access: [
        ["/run/user/1000/1password/agent.sock", "read-write"],
        ["/run/user/1000/bus", "hidden"],
        [`${HOME}/.gitconfig`, "read-only"],
        [`${HOME}/dotfiles/git/config`, "read-only"],
      ],
    },
  ])("$name", ({ input, access }) => {
    const policy = resolved(input);
    expect(access.map(([path]) => [path, accessOf(policy, path)])).toEqual(access);
  });

  it("orders each entry after every entry that contains it, without duplicates or redundancy", () => {
    const policy = resolved(linuxInput());
    const paths = policy.entries.map((entry) => entry.path);
    expect(new Set(paths).size).toBe(paths.length);
    policy.entries.forEach((entry, index) => {
      const later = policy.entries.slice(index + 1);
      expect(later.some((other) => entry.path.startsWith(`${other.path}/`))).toBe(false);
    });
    // Covered by a read-write parent, or by the read-only root.
    expect(paths).not.toContain(`${HOME}/.cache/tool/bin`);
    expect(paths).not.toContain(`${HOME}/.local/share/pnpm/bin`);
    expect(paths).not.toContain(`${HOME}/code/app/.git`);
    expect(paths).not.toContain(`${HOME}/.kinako`);
    expect(paths).not.toContain("/usr/bin");
    // Missing optional defaults are dropped.
    expect(paths).not.toContain(`${HOME}/.nvm`);
  });

  it("reports a socket that is no longer a socket and a TMPDIR outside temp", () => {
    const policy = resolved(
      linuxInput({ sshAuthSock: `${HOME}/.agent-dir`, tmpDir: `${HOME}/scratch` }),
    );
    expect(
      policy.rejected
        .filter(({ source }) => source === "temp" || source === "ssh-agent")
        .map(({ path, reason }) => [path, reason]),
    ).toEqual([
      [
        `${HOME}/scratch`,
        "TMPDIR is not a directory in a temp location; only the default temp dirs apply.",
      ],
      [`${HOME}/.agent-dir`, "Not a socket, so it is not exposed."],
    ]);
  });

  it("recreates the symlinks a listed path goes through, only inside hidden directories", () => {
    const policy = resolved(
      linuxInput({
        pathEnv: [`${HOME}/.fnm/aliases/default/bin`, `${HOME}/.tools/bin`, "/usr/bin"].join(":"),
        settings: { ...linuxInput().settings, readOnlyPaths: ["~/.config/git"] },
      }),
    );
    expect(
      policy.entries
        .filter((entry) => entry.kind === "symlink")
        .map(({ path, linkTarget }) => [path, linkTarget]),
    ).toEqual([
      [`${HOME}/.config/git`, `${HOME}/dotfiles/git`],
      [`${HOME}/.tools/bin`, "/opt/tools/bin"],
      [`${HOME}/.fnm/aliases/default`, `${HOME}/.fnm/node-versions/v24`],
    ]);
  });

  it("keeps read-write when a path is listed both ways", () => {
    const policy = resolved(
      linuxInput({
        settings: {
          ...linuxInput().settings,
          readOnlyPaths: ["~/.cache"],
          readWritePaths: ["~/.cache"],
        },
      }),
    );
    expect(policy.entries.filter((entry) => entry.path === `${HOME}/.cache`)).toEqual([
      {
        path: `${HOME}/.cache`,
        access: "read-write",
        kind: "directory",
        source: "user-read-write",
      },
    ]);
  });

  it("rejects user entries that would expose home or always-hidden paths", () => {
    const policy = resolved(
      linuxInput({
        settings: {
          ...linuxInput().settings,
          readWritePaths: [
            "~",
            "/home",
            "~/.kinako/userdata",
            "relative/dir",
            "/run/user/1000/bus",
          ],
          readOnlyPaths: ["~/.kinako/worktrees", "~/*/git"],
        },
      }),
    );
    expect(policy.rejected.map(({ path, reason }) => [path, reason])).toEqual([
      ["relative/dir", "Not an absolute or home-relative path."],
      [`${HOME}/*/git`, "Only the last path segment may hold a wildcard."],
      [HOME, "Exposes the whole home directory."],
      ["/home", "Exposes the whole home directory."],
      [`${HOME}/.kinako/userdata`, `Inside ${HOME}/.kinako, which always stays hidden.`],
      ["/run/user/1000/bus", "Inside /run/user/1000, which always stays hidden."],
      [`${HOME}/.kinako/worktrees`, `Inside ${HOME}/.kinako, which always stays hidden.`],
      [`${HOME}/.kinako/bin`, `Inside ${HOME}/.kinako, which always stays hidden.`],
    ]);
    expect(accessOf(policy, `${HOME}/code/other`)).toBe("hidden");
    expect(accessOf(policy, `${HOME}/.kinako/userdata/settings.json`)).toBe("hidden");
  });

  it("warns about listed paths that are missing or expose credentials, and keeps them", () => {
    const tree: Record<string, FakeEntry> = {
      ...LINUX_TREE,
      [`${HOME}/.config`]: "directory",
      [`${HOME}/.config/gh`]: "directory",
      [`${HOME}/.config/gcloud`]: "directory",
      [`${HOME}/.aws-sam`]: "directory",
    };
    const policy = resolved(
      linuxInput({
        settings: {
          ...linuxInput().settings,
          readWritePaths: ["~/.ssh", "~/missing", "~/.aws-sam", "~/.docker"],
          readOnlyPaths: ["~/.ssh/*", "~/.config", "~/nothing*", "~/.cargo/credentials.toml"],
        },
      }),
      tree,
    );
    expect(policy.warnings.map(({ path, reason }) => [path, reason])).toEqual([
      [`${HOME}/nothing*`, "Matches nothing yet, so it is skipped."],
      [`${HOME}/.ssh`, "May expose credentials kept in ~/.ssh."],
      [`${HOME}/missing`, "Does not exist yet, so it is skipped."],
      [`${HOME}/.docker`, "May expose credentials kept in ~/.docker."],
      [`${HOME}/.ssh/id_ed25519`, "May expose credentials kept in ~/.ssh."],
      [`${HOME}/.config`, "May expose credentials kept in ~/.config/gcloud and ~/.config/gh."],
      [
        `${HOME}/.cargo/credentials.toml`,
        "May expose credentials kept in ~/.cargo/credentials.toml.",
      ],
    ]);
    expect(accessOf(policy, `${HOME}/.ssh/id_ed25519`)).toBe("read-write");
    expect(
      resolved(linuxInput(), tree).warnings.filter(({ reason }) => reason.startsWith("May")),
    ).toEqual([]);
  });

  it.each<readonly [string, Partial<SandboxPolicyInput>, string]>([
    ["the home directory", { cwd: HOME, gitCommonDirs: [] }, "contains the whole home directory"],
    [
      "the base dir outside worktrees",
      { cwd: `${HOME}/.kinako/userdata` },
      `is inside ${HOME}/.kinako`,
    ],
    [
      "an additional directory containing the base dir",
      {
        additionalDirectories: [{ path: "/srv", access: "read-write" }],
        baseDir: "/srv/kinako",
        worktreesDir: "/srv/kinako/worktrees",
      },
      "contains /srv/kinako",
    ],
    ["a missing cwd", { cwd: `${HOME}/code/missing` }, "does not exist"],
  ])("refuses a workspace at %s", (_name, overrides, reason) => {
    const tree = { ...LINUX_TREE, "/srv": "directory" as const };
    const resolution = resolveSandboxPolicy(linuxInput(overrides), fakeFacts(tree));
    expect(resolution._tag === "Refused" ? resolution.reason : "resolved").toContain(reason);
  });
});

describe("effectiveSandboxSettings", () => {
  const defaults = {
    readWritePaths: null,
    readOnlyPaths: null,
    allowDocker: false,
    allowSshAgent: true,
  };

  it.each([
    ["linux", "~/.cache", "~/Library/Caches"],
    ["darwin", "~/Library/Caches", "~/.cache"],
  ] as const)("uses %s defaults", (platform, included, excluded) => {
    const settings = effectiveSandboxSettings(defaults, undefined, platform);
    expect(settings.readWritePaths).toContain(included);
    expect(settings.readWritePaths).not.toContain(excluded);
    expect(settings.readOnlyPaths).toContain("~/.ssh/*.pub");
    expect([...settings.readWritePaths, ...settings.readOnlyPaths]).not.toContain("~/.ssh");
  });

  it("lets a project add entries but keeps the environment's", () => {
    const settings = effectiveSandboxSettings(
      { ...defaults, readWritePaths: ["~/.npm"] },
      { readWritePaths: ["/data/fixtures"], readOnlyPaths: ["~/.m2"] },
      "linux",
    );
    expect(settings.readWritePaths).toEqual(["~/.npm", "/data/fixtures"]);
    expect(settings.readOnlyPaths.at(-1)).toBe("~/.m2");
  });

  const darwinInput = (overrides: Partial<SandboxPolicyInput> = {}): SandboxPolicyInput => ({
    ...linuxInput(),
    platform: "darwin",
    home: "/Users/user",
    cwd: "/Users/user/code/app",
    gitCommonDirs: [],
    providerPaths: [],
    serverPaths: [],
    baseDir: "/Users/user/.kinako",
    worktreesDir: "/Users/user/.kinako/worktrees",
    attachmentsDir: "/Users/user/.kinako/userdata/attachments",
    pathEnv: undefined,
    settings: effectiveSandboxSettings(defaults, undefined, "darwin"),
    ...overrides,
  });

  it("exposes macOS caches, masks Docker sockets, and has no runtime dir to hide", () => {
    const tree: Record<string, FakeEntry> = {
      "/Users/user": "directory",
      "/Users/user/code/app": "directory",
      "/Users/user/Library/Caches": "directory",
      "/private/tmp": "directory",
      "/tmp": { link: "/private/tmp" },
      "/private/var/run": "directory",
      "/var/run": { link: "/private/var/run" },
    };
    const policy = resolved(darwinInput(), tree);
    expect(policy.entries.map(({ path, access }) => [path, access])).toEqual([
      ["/Users/user", "hidden"],
      ["/private/tmp", "read-write"],
      ["/private/tmp/tmux-1000", "hidden"],
      ["/Users/user/Library/Caches", "read-write"],
      ["/Users/user/code/app", "read-write"],
      // Not there yet; Seatbelt denies it before Docker creates it.
      ["/private/var/run/docker.sock", "hidden"],
    ]);
  });

  it.each([
    ["exist", true],
    ["do not exist yet", false],
  ])("hides the user's screen and tmux socket dirs when they %s", (_, present) => {
    const temp = "/private/var/folders/xy/T";
    const tree: Record<string, FakeEntry> = {
      "/Users/user": "directory",
      "/Users/user/code/app": "directory",
      "/private/tmp": "directory",
      "/tmp": { link: "/private/tmp" },
      "/var": { link: "/private/var" },
      [temp]: "directory",
      ...(present
        ? { [`${temp}/.screen`]: "directory", "/private/tmp/tmux-1000": "directory" }
        : {}),
    };
    const policy = resolved(
      darwinInput({
        tmpDir: "/var/folders/xy/T",
        darwinUserTempDir: "/var/folders/xy/T",
        userName: "user",
      }),
      tree,
    );
    expect(accessOf(policy, `${temp}/scratch`)).toBe("read-write");
    expect(accessOf(policy, `${temp}/.screen/123.session`)).toBe("hidden");
    expect(accessOf(policy, "/private/tmp/tmux-1000/default")).toBe("hidden");
  });

  it("keeps one writable file inside a read-only provider directory", () => {
    const keychains = "/Users/user/Library/Keychains";
    const tree: Record<string, FakeEntry> = {
      "/Users/user": "directory",
      "/Users/user/code/app": "directory",
      [keychains]: "directory",
      [`${keychains}/login.keychain-db`]: "file",
    };
    const policy = resolved(
      darwinInput({
        providerPaths: [
          { path: keychains, access: "read-only" },
          { path: `${keychains}/login.keychain-db`, access: "read-write" },
        ],
      }),
      tree,
    );
    expect(accessOf(policy, `${keychains}/metadata.keychain-db`)).toBe("read-only");
    expect(accessOf(policy, `${keychains}/login.keychain-db`)).toBe("read-write");
  });

  it("masks Cargo token files under ~/.cargo whether or not they exist yet", () => {
    const tree: Record<string, FakeEntry> = {
      "/Users/user": "directory",
      "/Users/user/code/app": "directory",
      "/Users/user/.cargo": "directory",
      "/Users/user/.cargo/credentials.toml": "file",
    };
    const policy = resolved(darwinInput(), tree);
    expect(
      policy.entries
        .filter(({ path }) => path.startsWith("/Users/user/.cargo"))
        .map(({ path, access, kind }) => [path, access, kind]),
    ).toEqual([
      ["/Users/user/.cargo", "read-only", "directory"],
      ["/Users/user/.cargo/credentials", "hidden", "file"],
      ["/Users/user/.cargo/credentials.toml", "hidden", "file"],
    ]);
  });

  it("masks a Docker socket that appears later inside a symlinked ~/.docker", () => {
    const tree: Record<string, FakeEntry> = {
      "/Users/user": "directory",
      "/Users/user/code/app": "directory",
      "/Users/user/.docker": { link: "/Users/user/dotfiles/docker" },
      "/Users/user/dotfiles/docker": "directory",
      "/private/tmp": "directory",
      "/tmp": { link: "/private/tmp" },
    };
    const policy = resolved(
      darwinInput({
        settings: {
          ...effectiveSandboxSettings(defaults, undefined, "darwin"),
          readWritePaths: ["~/.docker"],
        },
      }),
      tree,
    );
    expect(
      policy.entries
        .filter(({ path }) => path.startsWith("/Users/user/dotfiles"))
        .map(({ path, access, kind }) => [path, access, kind]),
    ).toEqual([
      ["/Users/user/dotfiles/docker", "read-write", "directory"],
      ["/Users/user/dotfiles/docker/run/docker.sock", "hidden", "socket"],
    ]);
  });
});
