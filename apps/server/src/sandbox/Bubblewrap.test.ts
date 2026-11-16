import { assert, describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import * as Bubblewrap from "./Bubblewrap.ts";
import type { SandboxPolicy, SandboxPolicyEntry } from "./sandboxPolicy.ts";

const services = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));

const policyWith = (entries: ReadonlyArray<SandboxPolicyEntry>): SandboxPolicy => ({
  platform: "linux",
  cwd: "/home/user/code/app",
  entries,
  rejected: [],
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
