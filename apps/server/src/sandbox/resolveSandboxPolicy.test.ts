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

    const resolveIn = (cwd: string) =>
      resolveSandboxPolicy({
        platform: "linux",
        home,
        uid: 1000,
        cwd,
        gitCheckouts: [{ checkout: cwd, repository: main }],
        additionalDirectories: [],
        providerPaths: [
          { path: path.join(home, ".provider"), kind: "directory", access: "read-write" },
          { path: path.join(home, ".provider.json"), kind: "file", access: "read-write" },
        ],
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
    const accessIn = (policy: Effect.Success<ReturnType<typeof resolveIn>>) =>
      Object.fromEntries(
        policy.entries
          .filter((entry) => entry.path.startsWith(root))
          .map((entry) => [entry.path, entry.access]),
      );
    const policy = yield* resolveIn(worktree);

    assert.isTrue(yield* fileSystem.exists(path.join(home, ".provider")));
    assert.deepEqual(accessIn(policy), {
      [home]: "hidden",
      [path.join(home, ".provider")]: "read-write",
      [path.join(main, ".git")]: "read-write",
      [worktree]: "read-write",
    });

    // A plain checkout needs no grant beyond itself.
    assert.deepEqual(accessIn(yield* resolveIn(main)), {
      [home]: "hidden",
      [path.join(home, ".provider")]: "read-write",
      [main]: "read-write",
    });

    // The agent can point its checkout at another repository; the grant stays its own.
    const other = path.join(home, "code", "other");
    yield* fileSystem.makeDirectory(other, { recursive: true });
    yield* git(other, "init", "-q");
    yield* fileSystem.writeFileString(
      path.join(worktree, ".git"),
      `gitdir: ${path.join(other, ".git")}\n`,
    );
    const redirected = accessIn(yield* resolveIn(worktree));
    assert.equal(redirected[path.join(main, ".git")], "read-write");
    assert.isUndefined(redirected[path.join(other, ".git")]);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
