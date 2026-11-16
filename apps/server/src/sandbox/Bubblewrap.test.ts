import { assert, describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import * as Bubblewrap from "./Bubblewrap.ts";
import { resolveSandboxPolicy } from "./resolveSandboxPolicy.ts";
import {
  effectiveSandboxSettings,
  type SandboxPolicy,
  type SandboxPolicyEntry,
} from "./sandboxPolicy.ts";

const services = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));

const policyWith = (entries: ReadonlyArray<SandboxPolicyEntry>): SandboxPolicy => ({
  platform: "linux",
  cwd: "/home/user/code/app",
  entries,
  rejected: [],
  warnings: [],
});

describe("bubblewrapArgs", () => {
  const BASE = [
    "--die-with-parent",
    "--unshare-pid",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
  ];

  it.each<{
    readonly name: string;
    readonly entries: ReadonlyArray<SandboxPolicyEntry>;
    readonly mounts: ReadonlyArray<string>;
  }>([
    { name: "no entries", entries: [], mounts: [] },
    {
      name: "a hidden home with binds inside, remounted read-only after them",
      entries: [
        { path: "/home/user", access: "hidden", kind: "directory", source: "home" },
        {
          path: "/home/user/.cache",
          access: "read-write",
          kind: "directory",
          source: "user-read-write",
        },
        {
          path: "/home/user/.gitconfig",
          access: "read-only",
          kind: "file",
          source: "user-read-only",
        },
        { path: "/home/user/code/app", access: "read-write", kind: "directory", source: "cwd" },
      ],
      mounts: [
        "--tmpfs",
        "/home/user",
        "--bind",
        "/home/user/.cache",
        "/home/user/.cache",
        "--ro-bind",
        "/home/user/.gitconfig",
        "/home/user/.gitconfig",
        "--bind",
        "/home/user/code/app",
        "/home/user/code/app",
        "--remount-ro",
        "/home/user",
      ],
    },
    {
      name: "a masked socket and a runtime dir with one socket bound back",
      entries: [
        { path: "/run/docker.sock", access: "hidden", kind: "file", source: "docker" },
        { path: "/run/user/1000", access: "hidden", kind: "directory", source: "runtime-dir" },
        {
          path: "/run/user/1000/keyring/ssh",
          access: "read-write",
          kind: "file",
          source: "ssh-agent",
        },
      ],
      mounts: [
        "--ro-bind",
        "/dev/null",
        "/run/docker.sock",
        "--tmpfs",
        "/run/user/1000",
        "--bind",
        "/run/user/1000/keyring/ssh",
        "/run/user/1000/keyring/ssh",
        "--remount-ro",
        "/run/user/1000",
      ],
    },
    {
      name: "a symlink recreated in the hidden home after the binds",
      entries: [
        { path: "/home/user", access: "hidden", kind: "directory", source: "home" },
        {
          path: "/home/user/.config/git",
          access: "read-only",
          kind: "symlink",
          source: "user-read-only",
          linkTarget: "../dotfiles/git",
        },
        {
          path: "/home/user/dotfiles/git",
          access: "read-only",
          kind: "directory",
          source: "user-read-only",
        },
      ],
      mounts: [
        "--tmpfs",
        "/home/user",
        "--ro-bind",
        "/home/user/dotfiles/git",
        "/home/user/dotfiles/git",
        "--symlink",
        "../dotfiles/git",
        "/home/user/.config/git",
        "--remount-ro",
        "/home/user",
      ],
    },
  ])("$name", ({ entries, mounts }) => {
    expect(Bubblewrap.bubblewrapArgs(policyWith(entries))).toEqual([
      ...BASE,
      ...mounts,
      "--chdir",
      "/home/user/code/app",
    ]);
  });
});

describe("Bubblewrap", () => {
  it.effect.each<readonly [string, string, string]>([
    ["bwrap is missing", "kinako-no-such-bwrap", "bwrap was not found on PATH."],
    ["bwrap is refused", "false", "bwrap exited with code 1."],
  ])("fails closed when %s", ([, command, reason]) =>
    Effect.gen(function* () {
      const bubblewrap = yield* Bubblewrap.Bubblewrap;
      assert.deepEqual(yield* bubblewrap.availability, { _tag: "Unavailable", reason });
      const error = yield* bubblewrap
        .wrap({ command: "/bin/sh", args: [], policy: policyWith([]) })
        .pipe(Effect.flip);
      assert.equal(error.reason, reason);
    }).pipe(
      Effect.provide(
        Layer.effect(Bubblewrap.Bubblewrap, Bubblewrap.make({ command })).pipe(
          Layer.provideMerge(services),
        ),
      ),
      Effect.provideService(HostProcess.Platform, "linux"),
    ),
  );

  it.live("resolves links, masks tokens and keeps PATH read-only in a real policy", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runner = yield* ProcessRunner.ProcessRunner;
      const bubblewrap = yield* Bubblewrap.Bubblewrap;
      const root = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "kinako-bwrap-links-" }),
      );
      const home = path.join(root, "home");
      const project = path.join(root, "project");
      const installBin = path.join(home, ".fnm", "node-versions", "v24", "bin");
      yield* fileSystem.makeDirectory(installBin, { recursive: true });
      yield* fileSystem.makeDirectory(path.join(home, ".fnm", "aliases"));
      yield* fileSystem.makeDirectory(path.join(home, "dotfiles", "git"), { recursive: true });
      yield* fileSystem.makeDirectory(path.join(home, ".config"));
      yield* fileSystem.makeDirectory(path.join(home, ".cargo"));
      yield* fileSystem.makeDirectory(path.join(home, ".pnpm", "bin"), { recursive: true });
      yield* fileSystem.makeDirectory(project);
      yield* fileSystem.writeFileString(path.join(installBin, "tool"), "#!/bin/sh\necho tool=ok\n");
      yield* fileSystem.chmod(path.join(installBin, "tool"), 0o755);
      yield* fileSystem.writeFileString(path.join(home, "dotfiles", "git", "config"), "cfg\n");
      yield* fileSystem.writeFileString(
        path.join(home, "dotfiles", "git", "credentials"),
        "https://user:token@example.com\n",
      );
      yield* fileSystem.writeFileString(path.join(home, ".cargo", "config.toml"), "[build]\n");
      yield* fileSystem.writeFileString(path.join(home, ".cargo", "credentials.toml"), "token\n");
      yield* fileSystem.symlink(
        "../node-versions/v24",
        path.join(home, ".fnm", "aliases", "default"),
      );
      yield* fileSystem.symlink("../dotfiles/git", path.join(home, ".config", "git"));
      const aliasBin = path.join(home, ".fnm", "aliases", "default", "bin");

      const policy = yield* resolveSandboxPolicy({
        platform: "linux",
        home,
        uid: 1000,
        cwd: project,
        gitCheckouts: [],
        additionalDirectories: [],
        providerPaths: [],
        serverPaths: [],
        attachmentsDir: path.join(home, ".kinako", "userdata", "attachments"),
        baseDir: path.join(home, ".kinako"),
        worktreesDir: path.join(home, ".kinako", "worktrees"),
        pathEnv: `${aliasBin}:${home}/.pnpm/bin`,
        tmpDir: undefined,
        sshAuthSock: undefined,
        settings: effectiveSandboxSettings(
          {
            readWritePaths: ["~/.pnpm"],
            readOnlyPaths: ["~/.cargo"],
            allowDocker: false,
            allowSshAgent: false,
          },
          undefined,
          "linux",
        ),
      });
      const script = [
        `PATH=${aliasBin}:/usr/bin:/bin tool`,
        `cat ${home}/.config/git/config 2>/dev/null && echo git=ok || echo git=fail`,
        `ls ${home}/dotfiles 2>/dev/null | grep -q . && echo dotfiles=listed || echo dotfiles=hidden`,
        `cat ${home}/.cargo/config.toml`,
        `grep -q token ${home}/.cargo/credentials.toml 2>/dev/null && echo token=read || echo token=hidden`,
        `grep -q token ${home}/.config/git/credentials 2>/dev/null && echo git-token=read || echo git-token=hidden`,
        `touch ${home}/.pnpm/store && echo pnpm-home=writable || echo pnpm-home=read-only`,
        `touch ${home}/.pnpm/bin/git 2>/dev/null && echo path-bin=writable || echo path-bin=read-only`,
        `mv ${home}/.pnpm/bin ${home}/.pnpm/moved 2>/dev/null && echo path-bin=moved || echo path-bin=kept`,
      ].join("\n");
      const availability = yield* bubblewrap.availability;
      const wrapped = bubblewrap.wrap({ command: "/bin/sh", args: ["-c", script], policy });
      if (availability._tag === "Unavailable") {
        assert.equal((yield* Effect.flip(wrapped)).reason, availability.reason);
        return;
      }
      const command = yield* wrapped;
      const result = yield* runner.run({
        command: command.command,
        args: command.args,
        timeout: "30 seconds",
      });
      assert.equal(result.code, 0, result.stderr);
      // ~/.config/git is not listed here: git config is always readable, and its link must work.
      assert.deepEqual(result.stdout.trim().split("\n"), [
        "tool=ok",
        "cfg",
        "git=ok",
        "dotfiles=listed",
        "[build]",
        "token=hidden",
        "git-token=hidden",
        "pnpm-home=writable",
        "path-bin=read-only",
        "path-bin=kept",
      ]);
    }).pipe(Effect.scoped, Effect.provide(Bubblewrap.layer.pipe(Layer.provideMerge(services)))),
  );

  it.live("refuses the next spawn after the agent swaps a folder it was given for a link", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runner = yield* ProcessRunner.ProcessRunner;
      const bubblewrap = yield* Bubblewrap.Bubblewrap;
      const root = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "kinako-bwrap-swap-" }),
      );
      const home = path.join(root, "home");
      const project = path.join(root, "project");
      const given = path.join(project, "given");
      yield* fileSystem.makeDirectory(path.join(home, "private"), { recursive: true });
      yield* fileSystem.makeDirectory(given, { recursive: true });
      const policyFor = () =>
        resolveSandboxPolicy({
          platform: "linux",
          home,
          uid: 1000,
          cwd: project,
          gitCheckouts: [],
          additionalDirectories: [{ path: given, access: "read-write" }],
          providerPaths: [],
          serverPaths: [],
          attachmentsDir: path.join(home, ".kinako", "userdata", "attachments"),
          baseDir: path.join(home, ".kinako"),
          worktreesDir: path.join(home, ".kinako", "worktrees"),
          pathEnv: undefined,
          tmpDir: undefined,
          sshAuthSock: undefined,
          settings: effectiveSandboxSettings(
            { readWritePaths: [], readOnlyPaths: [], allowDocker: false, allowSshAgent: false },
            undefined,
            "linux",
          ),
        });
      const availability = yield* bubblewrap.availability;
      if (availability._tag === "Available") {
        // The folder sits inside the workspace, so it is no mount point and the agent can swap it.
        const command = yield* bubblewrap.wrap({
          command: "/bin/sh",
          args: ["-c", `rmdir ${given} && ln -s ${home}/private ${given} && echo swapped`],
          policy: yield* policyFor(),
        });
        const result = yield* runner.run({
          command: command.command,
          args: command.args,
          timeout: "30 seconds",
        });
        assert.equal(result.stdout.trim(), "swapped", result.stderr);
      } else {
        yield* fileSystem.remove(given);
        yield* fileSystem.symlink(path.join(home, "private"), given);
      }
      const refused = yield* Effect.flip(policyFor());
      expect(refused.reason).toContain(
        `resolves through a symbolic link the sandbox can rewrite, to ${home}/private`,
      );
    }).pipe(Effect.scoped, Effect.provide(Bubblewrap.layer.pipe(Layer.provideMerge(services)))),
  );

  it.live("keeps the user's and other threads' multiplexer sockets out of reach", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runner = yield* ProcessRunner.ProcessRunner;
      const bubblewrap = yield* Bubblewrap.Bubblewrap;
      const root = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "kinako-bwrap-mux-" }),
      );
      const home = path.join(root, "home");
      const project = path.join(root, "project");
      const own = path.join(root, "mux", "own");
      const other = path.join(root, "mux", "other");
      const tmux = path.join(root, "tmux-1000");
      for (const directory of [home, project, own, other, tmux]) {
        yield* fileSystem.makeDirectory(directory, { recursive: true });
      }
      yield* fileSystem.writeFileString(path.join(other, "default"), "");
      const policy = yield* resolveSandboxPolicy({
        platform: "linux",
        home,
        uid: 1000,
        cwd: project,
        gitCheckouts: [],
        additionalDirectories: [],
        providerPaths: [],
        serverPaths: [],
        attachmentsDir: path.join(home, ".kinako", "userdata", "attachments"),
        baseDir: path.join(home, ".kinako"),
        worktreesDir: path.join(home, ".kinako", "worktrees"),
        pathEnv: undefined,
        tmpDir: undefined,
        sshAuthSock: undefined,
        tmuxTmpDir: root,
        multiplexerDir: own,
        settings: effectiveSandboxSettings(
          { readWritePaths: [], readOnlyPaths: [], allowDocker: false, allowSshAgent: false },
          undefined,
          "linux",
        ),
      });
      const script = [
        `touch ${own}/default && echo own=ok || echo own=fail`,
        `test -e ${other}/default && echo other=reachable || echo other=hidden`,
        // A tmpfs over the dir: a tmux server the user starts later stays out of view.
        `grep -q " ${tmux} " /proc/self/mountinfo && echo tmux=masked || echo tmux=open`,
      ].join("\n");
      const availability = yield* bubblewrap.availability;
      const wrapped = bubblewrap.wrap({ command: "/bin/sh", args: ["-c", script], policy });
      if (availability._tag === "Unavailable") {
        assert.equal((yield* Effect.flip(wrapped)).reason, availability.reason);
        return;
      }
      const command = yield* wrapped;
      const result = yield* runner.run({
        command: command.command,
        args: command.args,
        timeout: "30 seconds",
      });
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(result.stdout.trim().split("\n"), ["own=ok", "other=hidden", "tmux=masked"]);
    }).pipe(Effect.scoped, Effect.provide(Bubblewrap.layer.pipe(Layer.provideMerge(services)))),
  );

  // Hosts without a working bwrap still check the other half of the contract: wrap refuses.
  it.live("confines a real child to its policy, or refuses to wrap where bwrap cannot run", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runner = yield* ProcessRunner.ProcessRunner;
      const bubblewrap = yield* Bubblewrap.Bubblewrap;
      const root = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "kinako-bwrap-" }),
      );
      const home = path.join(root, "home");
      const project = path.join(root, "project");
      const outside = path.join(root, "outside");
      yield* fileSystem.makeDirectory(path.join(home, "secret"), { recursive: true });
      yield* fileSystem.makeDirectory(project);
      yield* fileSystem.makeDirectory(outside);
      yield* fileSystem.writeFileString(path.join(home, "secret", "key"), "secret");
      const policy: SandboxPolicy = {
        platform: "linux",
        cwd: project,
        entries: [
          { path: home, access: "hidden", kind: "directory", source: "home" },
          { path: project, access: "read-write", kind: "directory", source: "cwd" },
        ],
        rejected: [],
        warnings: [],
      };
      const script = [
        "touch inside && echo inside=ok || echo inside=fail",
        `touch ${outside}/escape 2>/dev/null && echo outside=ok || echo outside=fail`,
        `cat ${home}/secret/key 2>/dev/null && echo secret=ok || echo secret=fail`,
        `touch ${home}/stray 2>/dev/null && echo home=ok || echo home=fail`,
      ].join("\n");

      const availability = yield* bubblewrap.availability;
      const wrapped = bubblewrap.wrap({ command: "/bin/sh", args: ["-c", script], policy });
      if (availability._tag === "Unavailable") {
        const error = yield* Effect.flip(wrapped);
        assert.equal(error.reason, availability.reason);
        return;
      }

      const command = yield* wrapped;
      const result = yield* runner.run({
        command: command.command,
        args: command.args,
        timeout: "30 seconds",
      });
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(result.stdout.trim().split("\n"), [
        "inside=ok",
        "outside=fail",
        "secret=fail",
        "home=fail",
      ]);
      assert.isTrue(yield* fileSystem.exists(path.join(project, "inside")));
      assert.isFalse(yield* fileSystem.exists(path.join(outside, "escape")));
      assert.isFalse(yield* fileSystem.exists(path.join(home, "stray")));
    }).pipe(Effect.scoped, Effect.provide(Bubblewrap.layer.pipe(Layer.provideMerge(services)))),
  );
});
