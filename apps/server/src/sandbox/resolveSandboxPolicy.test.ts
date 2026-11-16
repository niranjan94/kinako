import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import { resolveSandboxPolicy } from "./resolveSandboxPolicy.ts";
import { effectiveSandboxSettings } from "./sandboxPolicy.ts";

const layer = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));

it.live("resolves a linked worktree against the real filesystem and git", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runner = yield* ProcessRunner.ProcessRunner;
    const root = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "kinako-sandbox-resolve-" }),
    );
    const home = path.join(root, "home");
    const main = path.join(home, "code", "main");
    const worktree = path.join(home, "code", "wt");
    yield* fileSystem.makeDirectory(main, { recursive: true });
    const git = (cwd: string, ...args: ReadonlyArray<string>) =>
      runner.run({
        command: "git",
        args: ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
        cwd,
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      });
    yield* git(main, "init", "-q");
    yield* git(main, "commit", "-q", "--allow-empty", "-m", "base");
    yield* git(main, "worktree", "add", "-q", worktree);

    const policy = yield* resolveSandboxPolicy({
      platform: "linux",
      home,
      uid: 1000,
      cwd: worktree,
      additionalDirectories: [],
      providerPaths: [
        { path: path.join(home, ".provider"), kind: "directory" },
        { path: path.join(home, ".provider.json"), kind: "file" },
      ],
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

    assert.isTrue(yield* fileSystem.exists(path.join(home, ".provider")));
    const access = Object.fromEntries(
      policy.entries
        .filter((entry) => entry.path.startsWith(root))
        .map((entry) => [entry.path, entry.access]),
    );
    assert.deepEqual(access, {
      [home]: "hidden",
      [path.join(home, ".provider")]: "read-write",
      [path.join(main, ".git")]: "read-write",
      [worktree]: "read-write",
    });
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
