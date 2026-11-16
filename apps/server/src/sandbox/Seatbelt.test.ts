import { assert, describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import * as Sandbox from "./Sandbox.ts";
import * as Seatbelt from "./Seatbelt.ts";
import type { SandboxPolicy, SandboxPolicyEntry } from "./sandboxPolicy.ts";

const services = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));

const HOME = "/Users/user";

const policyWith = (entries: ReadonlyArray<SandboxPolicyEntry>): SandboxPolicy => ({
  platform: "darwin",
  cwd: `${HOME}/code/app`,
  entries,
  rejected: [],
});

const HEADER = [
  "(version 1)",
  "(allow default)",
  '(deny file-write* (subpath "/"))',
  '(allow file-write-data file-ioctl (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (subpath "/dev/fd") (literal "/dev/tty") (regex #"^/dev/ttys[0-9]+$") (literal "/dev/ptmx"))',
];
const FOOTER = ["(deny signal)", "(allow signal (target same-sandbox))"];

const profileOf = (entries: ReadonlyArray<SandboxPolicyEntry>) => {
  const built = Seatbelt.seatbeltProfile(policyWith(entries));
  assert.equal(built._tag, "Built");
  return built._tag === "Built" ? built.profile.split("\n") : [];
};

describe("seatbeltProfile", () => {
  it.each<{
    readonly name: string;
    readonly entries: ReadonlyArray<SandboxPolicyEntry>;
    readonly rules: ReadonlyArray<string>;
  }>([
    { name: "no entries emits no filterless rule", entries: [], rules: [] },
    {
      name: "home hidden, then each allowed path re-opened with its ancestors",
      entries: [
        { path: HOME, access: "hidden", kind: "directory", source: "home" },
        { path: "/private/tmp", access: "read-write", kind: "directory", source: "temp" },
        { path: `${HOME}/.gitconfig`, access: "read-only", kind: "file", source: "git-config" },
        { path: `${HOME}/.claude.json`, access: "read-write", kind: "file", source: "provider" },
        { path: `${HOME}/code/app`, access: "read-write", kind: "directory", source: "cwd" },
        {
          path: `${HOME}/.1password/agent.sock`,
          access: "read-write",
          kind: "socket",
          source: "user-read-write",
        },
      ],
      rules: [
        `(deny file-read* file-test-existence file-write* (subpath "${HOME}"))`,
        '(allow file-read* file-test-existence file-write* (subpath "/private/tmp"))',
        `(allow file-read-metadata file-test-existence (path-ancestors "${HOME}/.gitconfig"))`,
        `(allow file-read* file-test-existence (literal "${HOME}/.gitconfig"))`,
        `(allow file-read-metadata file-test-existence (path-ancestors "${HOME}/.claude.json"))`,
        `(allow file-read* file-test-existence file-write* (regex #"^/Users/user/\\.claude\\.json($|\\.)"))`,
        `(allow file-read-metadata file-test-existence (path-ancestors "${HOME}/code/app"))`,
        `(allow file-read* file-test-existence file-write* (subpath "${HOME}/code/app"))`,
        `(allow file-read-metadata file-test-existence (path-ancestors "${HOME}/.1password/agent.sock"))`,
        `(allow file-read* file-test-existence file-write* (literal "${HOME}/.1password/agent.sock"))`,
      ],
    },
    {
      name: "a base dir outside home denied after a broader allow, then a worktree carved out of it",
      entries: [
        { path: "/srv", access: "read-write", kind: "directory", source: "user-read-write" },
        { path: "/srv/kinako", access: "hidden", kind: "directory", source: "kinako-base-dir" },
        {
          path: "/srv/kinako/userdata/attachments",
          access: "read-only",
          kind: "directory",
          source: "attachments",
        },
        {
          path: "/srv/kinako/worktrees/app/t1",
          access: "read-write",
          kind: "directory",
          source: "cwd",
        },
      ],
      rules: [
        '(allow file-read* file-test-existence file-write* (subpath "/srv"))',
        '(deny file-read* file-test-existence file-write* (subpath "/srv/kinako"))',
        '(allow file-read-metadata file-test-existence (path-ancestors "/srv/kinako/userdata/attachments"))',
        '(allow file-read* file-test-existence (subpath "/srv/kinako/userdata/attachments"))',
        '(allow file-read-metadata file-test-existence (path-ancestors "/srv/kinako/worktrees/app/t1"))',
        '(allow file-read* file-test-existence file-write* (subpath "/srv/kinako/worktrees/app/t1"))',
      ],
    },
    {
      name: "docker sockets masked even under a listed ~/.docker",
      entries: [
        { path: HOME, access: "hidden", kind: "directory", source: "home" },
        {
          path: `${HOME}/.docker`,
          access: "read-write",
          kind: "directory",
          source: "user-read-write",
        },
        {
          path: `${HOME}/.docker/run/docker.sock`,
          access: "hidden",
          kind: "socket",
          source: "docker",
        },
      ],
      rules: [
        `(deny file-read* file-test-existence file-write* (subpath "${HOME}"))`,
        `(allow file-read-metadata file-test-existence (path-ancestors "${HOME}/.docker"))`,
        `(allow file-read* file-test-existence file-write* (subpath "${HOME}/.docker"))`,
        `(deny file-read* file-test-existence file-write* (literal "${HOME}/.docker/run/docker.sock"))`,
      ],
    },
    {
      name: "quotes, backslashes and regex metacharacters escaped",
      entries: [
        {
          path: '/Volumes/My "Disk"\\x',
          access: "read-only",
          kind: "directory",
          source: "user-read-only",
        },
        {
          path: "/opt/a+b (1)/c.[x]",
          access: "read-write",
          kind: "file",
          source: "user-read-write",
        },
      ],
      rules: [
        '(allow file-read* file-test-existence (subpath "/Volumes/My \\"Disk\\"\\\\x"))',
        '(allow file-read* file-test-existence file-write* (regex #"^/opt/a\\+b \\(1\\)/c\\.\\[x\\]($|\\.)"))',
      ],
    },
  ])("$name", ({ entries, rules }) => {
    expect(profileOf(entries)).toEqual([...HEADER, ...rules, ...FOOTER]);
  });

  it("refuses a replaced-atomically file whose path cannot be put in a regex", () => {
    const built = Seatbelt.seatbeltProfile(
      policyWith([{ path: '/tmp/a"b', access: "read-write", kind: "file", source: "provider" }]),
    );
    expect(built).toEqual({ _tag: "Refused", reason: 'The path "/tmp/a\\"b" cannot be matched.' });
  });

  it("refuses a profile over the size limit instead of launching", () => {
    const entries = Array.from({ length: 1_000 }, (_, index) => ({
      path: `/srv/projects/a-fairly-long-directory-name-${index}`,
      access: "read-write" as const,
      kind: "directory" as const,
      source: "user-read-write" as const,
    }));
    const built = Seatbelt.seatbeltProfile(policyWith(entries));
    assert.equal(built._tag, "Refused");
    expect(built._tag === "Refused" ? built.reason : "").toMatch(
      /^The sandbox profile is \d+ bytes, over the 65535-byte limit\./,
    );
  });
});

describe("Sandbox", () => {
  const sandboxFor = (platform: NodeJS.Platform) =>
    Sandbox.Sandbox.pipe(
      Effect.provide(Sandbox.layer.pipe(Layer.provideMerge(services))),
      Effect.provideService(HostProcess.Platform, platform),
    );

  it.effect("refuses on platforms with no sandbox", () =>
    Effect.gen(function* () {
      const sandbox = yield* sandboxFor("win32");
      const error = yield* sandbox
        .wrap({ command: "agent", args: [], policy: policyWith([]) })
        .pipe(Effect.flip);
      assert.equal(error.reason, "The filesystem sandbox only runs on Linux and macOS.");
    }),
  );

  it.effect("refuses a policy built for the other platform", () =>
    Effect.gen(function* () {
      const sandbox = yield* sandboxFor("linux");
      const error = yield* sandbox
        .wrap({ command: "agent", args: [], policy: policyWith([]) })
        .pipe(Effect.flip);
      assert.equal(error.reason, "This policy is not for a Linux sandbox.");
    }),
  );

  // Off macOS this checks the other half of the contract: wrap refuses.
  it.live("confines a real child on macOS, or refuses to wrap elsewhere", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runner = yield* ProcessRunner.ProcessRunner;
      const seatbelt = yield* Seatbelt.Seatbelt;
      const root = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "kinako-seatbelt-" }),
      );
      const home = path.join(root, "home");
      const project = path.join(root, "project");
      const outside = path.join(root, "outside");
      yield* fileSystem.makeDirectory(path.join(home, "secret"), { recursive: true });
      yield* fileSystem.makeDirectory(project);
      yield* fileSystem.makeDirectory(outside);
      yield* fileSystem.writeFileString(path.join(home, "secret", "key"), "secret");
      const policy: SandboxPolicy = {
        platform: "darwin",
        cwd: project,
        entries: [
          { path: home, access: "hidden", kind: "directory", source: "home" },
          { path: project, access: "read-write", kind: "directory", source: "cwd" },
        ],
        rejected: [],
      };
      const script = [
        `cd ${project}`,
        "touch inside && echo inside=ok || echo inside=fail",
        `touch ${outside}/escape 2>/dev/null && echo outside=ok || echo outside=fail`,
        `cat ${home}/secret/key 2>/dev/null && echo secret=ok || echo secret=fail`,
      ].join("\n");

      const availability = yield* seatbelt.availability;
      const wrapped = seatbelt.wrap({ command: "/bin/sh", args: ["-c", script], policy });
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
      ]);
      assert.isFalse(yield* fileSystem.exists(path.join(outside, "escape")));
    }).pipe(Effect.scoped, Effect.provide(Seatbelt.layer.pipe(Layer.provideMerge(services)))),
  );
});
