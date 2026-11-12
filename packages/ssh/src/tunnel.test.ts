// @effect-diagnostics nodeBuiltinImport:off - Runs the generated runner in a real shell.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthStandardClientScopes } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as SshAuth from "./auth.ts";
import { remoteStateKey } from "./command.ts";
import { SshCommandError, SshPasswordPromptError, SshReadinessError } from "./errors.ts";
import * as SshTunnel from "./tunnel.ts";

const isSshCommandError = Schema.is(SshCommandError);

const makeSuccessfulProcess = (stdout: string) => {
  const stdoutStream = Stream.make(new TextEncoder().encode(stdout));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: stdoutStream,
    stderr: Stream.empty,
    all: stdoutStream,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const makeRunningProcess = (onKill: () => void) => {
  let finish: ((exitCode: ChildProcessSpawner.ExitCode) => void) | null = null;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Effect.callback<ChildProcessSpawner.ExitCode>((resume) => {
      finish = (exitCode) => resume(Effect.succeed(exitCode));
      return Effect.sync(() => {
        finish = null;
      });
    }),
    isRunning: Effect.succeed(true),
    kill: () =>
      Effect.sync(() => {
        onKill();
        finish?.(ChildProcessSpawner.ExitCode(143));
      }),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const testHttpClient = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
);

const hangingHttpClient = HttpClient.make(() => Effect.never);

const testNetService = NetService.NetService.of({
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: () => Effect.succeed(true),
  hasListenerOnHost: () => Effect.succeed(true),
  reserveLoopbackPort: () => Effect.succeed(41_773),
  findAvailablePort: (preferred) => Effect.succeed(preferred),
});

function commandArgs(command: ChildProcess.Command): ReadonlyArray<string> {
  return command._tag === "StandardCommand" ? command.args.map(String) : [];
}

const ARCHIVE = { archiveVersion: "1.2.3-preview.20260911.4" } as const;

const SSH_TARGET = { alias: "devbox", hostname: "devbox", username: null, port: null } as const;

// Runs a remote operation against a fake ssh and returns the script it piped to the remote shell.
const captureRemoteScript = <A, E, R>(run: Effect.Effect<A, E, R>, stdout: string) =>
  Effect.gen(function* () {
    const scripts: Array<string> = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        const stdin = command._tag === "StandardCommand" ? command.options.stdin : undefined;
        if (typeof stdin === "object" && "stream" in stdin && typeof stdin.stream !== "string") {
          scripts.push(yield* stdin.stream.pipe(Stream.decodeText(), Stream.mkString));
        }
        return makeSuccessfulProcess(stdout);
      }),
    );
    yield* run.pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      ),
    );
    const script = scripts.at(-1);
    assert.isDefined(script);
    return script;
  });

// Emulates `t3 serve`: it takes the home owner lock at startup, then binds
// once a second server has tried the same home (or after 2s), so a concurrent
// launch always sees the home still unclaimed. Like the real server, it
// publishes server-runtime.json after it starts answering HTTP, if at all.
const fakeT3Serve = (publishDelayMs: number | null) => `const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const userdata = path.join(args[args.indexOf("--base-dir") + 1], "userdata");
const servers = path.join(process.env.HOME, "servers");
fs.mkdirSync(userdata, { recursive: true });
fs.appendFileSync(servers, process.pid + "\\n");
try {
  fs.writeFileSync(path.join(userdata, "server.lock"), String(process.pid), { flag: "wx" });
} catch {
  console.error("ServerAlreadyRunningError: another server owns " + userdata);
  process.exit(1);
}
setTimeout(() => process.exit(0), 60_000);
const serve = (tries) => {
  if (tries > 0 && fs.readFileSync(servers, "utf8").trim().split("\\n").length < 2) {
    setTimeout(() => serve(tries - 1), 50);
    return;
  }
  http.createServer((_, response) => response.end()).listen(port, "127.0.0.1", () => {
    const origin = "http://127.0.0.1:" + port;
    ${publishDelayMs === null ? "return;" : ""}
    setTimeout(() => {
      fs.writeFileSync(path.join(userdata, "server-runtime.json"), JSON.stringify({ pid: process.pid, port, origin }));
    }, ${publishDelayMs});
  });
};
serve(40);
`;

// Runs the remote half of an SSH command (`sh -l -s -- <key>`) as a local shell
// whose HOME is the given directory. Every launch after the first starts once
// a server is running (or after 10s), which lines up the race deterministically.
const localRemoteShellLayer = (home: string) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      let launches = 0;
      return ChildProcessSpawner.make((command) => {
        if (command._tag !== "StandardCommand") return spawner.spawn(command);
        const gate =
          launches++ === 0
            ? ""
            : 'i=0; while [ ! -s "$HOME/servers" ] && [ "$i" -lt 200 ]; do sleep 0.05; i=$((i+1)); done; ';
        return spawner.spawn(
          ChildProcess.make(
            "sh",
            ["-c", `${gate}exec sh -s -- "$1"`, "sh", ...commandArgs(command).slice(-1)],
            {
              ...command.options,
              env: { ...command.options.env, HOME: home },
              // Like an SSH session ending, the shell's exit leaves its nohup'd server running.
              detached: false,
            },
          ),
        );
      });
    }),
  );

describe("ssh tunnel scripts", () => {
  it("rejects archive versions that are not a single exact version segment", () => {
    for (const archiveVersion of [
      "../other",
      "1.2.3/evil",
      "1.2.3\\evil",
      "1.2.3-preview.1 x",
      "1.2.3-preview.1\nrm -rf /",
      "v1.2.3",
    ]) {
      assert.throws(
        () => SshTunnel.buildRemoteT3RunnerScript({ archiveVersion }),
        SshTunnel.SshInvalidArchiveVersionError,
        undefined,
        archiveVersion,
      );
    }
    assert.include(
      SshTunnel.buildRemoteT3RunnerScript(ARCHIVE),
      "T3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'",
    );
  });

  it.effect("pairs remote environments with the standard client scopes", () =>
    Effect.gen(function* () {
      const pairing = yield* captureRemoteScript(
        SshTunnel.issueRemotePairingToken(SSH_TARGET, undefined, ARCHIVE),
        '{"credential":"LCL4R2TPHDKQ"}\n',
      );
      assert.match(
        pairing,
        /^"\$RUNNER_FILE" auth pairing create --base-dir "\$PAIRING_BASE_DIR"( --scope \S+)+ --json$/m,
      );
      const pairingScopes = [...pairing.matchAll(/--scope (\S+)/g)].map((match) => match[1]);
      assert.deepStrictEqual(pairingScopes, [...AuthStandardClientScopes]);
    }),
  );

  it.each([
    { host: "Darwin x86_64", system: "Darwin", machine: "x86_64", downloads: false },
    { host: "Darwin arm64", system: "Darwin", machine: "arm64", downloads: true },
  ])(
    "only downloads a release archive the host can run: $host",
    ({ system, machine, downloads }) => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ssh-runner-"));
      try {
        const bin = NodePath.join(root, "bin");
        NodeFS.mkdirSync(bin);
        NodeFS.mkdirSync(NodePath.join(root, "home"));
        NodeFS.writeFileSync(
          NodePath.join(bin, "uname"),
          `#!/bin/sh\ncase "$1" in -s) echo ${system} ;; -m) echo ${machine} ;; esac\n`,
          { mode: 0o755 },
        );
        NodeFS.writeFileSync(
          NodePath.join(bin, "curl"),
          "#!/bin/sh\necho 'download attempt' >&2\nexit 22\n",
          { mode: 0o755 },
        );
        const runner = NodePath.join(root, "run-t3.sh");
        NodeFS.writeFileSync(runner, SshTunnel.buildRemoteT3RunnerScript(ARCHIVE));
        const result = NodeChildProcess.spawnSync("sh", [runner, "--version"], {
          encoding: "utf8",
          env: { HOME: NodePath.join(root, "home"), PATH: `${bin}:${process.env.PATH ?? ""}` },
        });
        assert.notEqual(result.status, 0);
        if (downloads) {
          assert.include(result.stderr, "download attempt");
        } else {
          assert.notInclude(result.stderr, "download attempt");
          assert.include(result.stderr, "has no t3 release archive.");
        }
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.effect("accepts launch JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawnedCommands: Array<ReadonlyArray<string>> = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        spawnedCommands.push(commandArgs(command));
        return makeSuccessfulProcess('loaded nvm default\n{"remotePort":3774}\n');
      }),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.merge(
      Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
      layerSpawner,
    );

    return Effect.gen(function* () {
      const result = yield* SshTunnel.launchOrReuseRemoteServer(target, undefined, ARCHIVE);
      assert.equal(result.remotePort, 3774);
      assert.deepEqual(spawnedCommands[0]?.slice(-5, -1), ["sh", "-l", "-s", "--"]);
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect("accepts pretty-printed pairing JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeSuccessfulProcess(`loaded nvm default
{
  "id": "88941235-6ed5-4184-a2ff-5339e2075958",
  "credential": "LCL4R2TPHDKQ",
  "scopes": ["orchestration:read"],
  "expiresAt": "2026-04-29T01:01:20.994Z"
}

`),
      ),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.merge(
      Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
      layerSpawner,
    );
    return Effect.gen(function* () {
      const result = yield* SshTunnel.issueRemotePairingToken(target, undefined, ARCHIVE);
      assert.equal(result.credential, "LCL4R2TPHDKQ");
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect("restores the previous network access when the relaunch fails", () =>
    Effect.gen(function* () {
      const saved: Array<boolean> = [];
      let launches = 0;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const args = commandArgs(command);
          if (args.includes("-N")) return makeRunningProcess(() => {});
          if (args.some((arg, index) => arg === "-s" && args[index + 1] === "--")) {
            launches += 1;
            return makeSuccessfulProcess(
              launches === 2
                ? ""
                : '{"remotePort":3773,"serverKind":"managed","networkAccess":false}\n',
            );
          }
          const stdin = command._tag === "StandardCommand" ? command.options.stdin : undefined;
          if (typeof stdin === "object" && "stream" in stdin && typeof stdin.stream !== "string") {
            const script = yield* stdin.stream.pipe(Stream.decodeText(), Stream.mkString);
            const preference = /if \[ "([01])" = "1" \]/.exec(script)?.[1];
            if (preference !== undefined) saved.push(preference === "1");
          }
          return makeSuccessfulProcess("");
        }),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, testHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
        yield* manager.ensureEnvironment(target);

        assert.deepEqual(yield* manager.setNetworkAccess(target, false), {
          serverKind: "managed",
          networkAccess: false,
        });
        assert.equal(launches, 1);

        const failed = yield* Effect.result(manager.setNetworkAccess(target, true));
        assert.isTrue(Result.isFailure(failed));
        assert.deepEqual(saved, [false, true, false]);
        assert.equal(launches, 3);
        assert.deepEqual(yield* manager.getNetworkAccess(target), {
          serverKind: "managed",
          networkAccess: false,
        });
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect("retains a bounded diagnostic tail when the tunnel exits before readiness", () =>
    Effect.gen(function* () {
      const diagnostic = "Connection refused: café";
      const output = new TextEncoder().encode(
        "old diagnostics\n" + "x".repeat(32_768) + "\n" + diagnostic,
      );
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.succeed(
          commandArgs(command).includes("-N")
            ? {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
                stderr: Stream.make(output.subarray(0, output.length - 1), output.subarray(-1)),
              }
            : makeSuccessfulProcess('{"remotePort":3773}\n'),
        ),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, hangingHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const result = yield* Effect.result(
          manager.ensureEnvironment({
            alias: "devbox",
            hostname: "devbox",
            username: null,
            port: null,
          }),
        );
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, SshCommandError);
          if (isSshCommandError(result.failure)) {
            assert.equal(result.failure.exitCode, 1);
            assert.equal(result.failure.stderr.length, 16_384);
            assert.isTrue(result.failure.stderr.endsWith(diagnostic));
            assert.equal(result.failure.message, result.failure.stderr.trim());
          }
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect("reports the real exit when reading tunnel diagnostics fails", () =>
    Effect.gen(function* () {
      const diagnostic = "Permission denied (publickey)";
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.succeed(
          commandArgs(command).includes("-N")
            ? {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(255)),
                stderr: Stream.make(new TextEncoder().encode(diagnostic)).pipe(
                  Stream.concat(
                    Stream.fail(
                      PlatformError.systemError({
                        _tag: "Unknown",
                        module: "Stream",
                        method: "read",
                        description: "stderr read failed",
                      }),
                    ),
                  ),
                ),
              }
            : makeSuccessfulProcess('{"remotePort":3773}\n'),
        ),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, hangingHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const result = yield* Effect.result(
          manager.ensureEnvironment({
            alias: "devbox",
            hostname: "devbox",
            username: null,
            port: null,
          }),
        );
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, SshCommandError);
          if (isSshCommandError(result.failure)) {
            assert.equal(result.failure.exitCode, 255);
            assert.equal(result.failure.stderr, diagnostic);
          }
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect("waits for a tunnel whose ssh connection outlasts the readiness timeout", () =>
    Effect.gen(function* () {
      const LOCAL_PORT = 41_773;
      // ssh spends ConnectTimeout on each unreachable address before the forward listens.
      const SSH_CONNECT_MS = 25_000;
      let forwardListensAt = Number.POSITIVE_INFINITY;
      const tunnelSpawned = yield* Deferred.make<void>();
      const forwardListening = (port: number) =>
        Clock.currentTimeMillis.pipe(
          Effect.map((now) => port === LOCAL_PORT && now >= forwardListensAt),
        );
      const spawner = ChildProcessSpawner.make((command) =>
        commandArgs(command).includes("-N")
          ? Effect.gen(function* () {
              forwardListensAt = (yield* Clock.currentTimeMillis) + SSH_CONNECT_MS;
              yield* Deferred.succeed(tunnelSpawned, undefined);
              return makeRunningProcess(() => undefined);
            })
          : Effect.succeed(makeSuccessfulProcess('{"remotePort":3773}\n')),
      );
      const httpClient = HttpClient.make((request) =>
        forwardListening(LOCAL_PORT).pipe(
          Effect.flatMap((listening) =>
            listening
              ? Effect.succeed(
                  HttpClientResponse.fromWeb(request, new Response("", { status: 200 })),
                )
              : Effect.fail(
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({
                      request,
                      description: `connect ECONNREFUSED 127.0.0.1:${LOCAL_PORT}`,
                    }),
                  }),
                ),
          ),
        ),
      );
      const net = NetService.NetService.of({
        ...testNetService,
        reserveLoopbackPort: () => Effect.succeed(LOCAL_PORT),
        canListenOnHost: (port) =>
          forwardListening(port).pipe(Effect.map((listening) => !listening)),
        isPortAvailableOnLoopback: (port) =>
          forwardListening(port).pipe(Effect.map((listening) => !listening)),
        hasListenerOnHost: (port) => forwardListening(port),
      });
      const layer = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, httpClient),
        Layer.succeed(NetService.NetService, net),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const ensure = yield* Effect.forkChild(
          manager.ensureEnvironment({
            alias: "devbox",
            hostname: "devbox",
            username: null,
            port: null,
          }),
        );
        yield* Deferred.await(tunnelSpawned);
        yield* TestClock.adjust(Duration.seconds(60));
        const environment = yield* Fiber.join(ensure);
        assert.equal(environment.httpBaseUrl, `http://127.0.0.1:${LOCAL_PORT}/`);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect("fails with a readiness error when ssh never connects", () =>
    Effect.gen(function* () {
      const tunnelSpawned = yield* Deferred.make<void>();
      let tunnelKilled = false;
      const spawner = ChildProcessSpawner.make((command) =>
        commandArgs(command).includes("-N")
          ? Deferred.succeed(tunnelSpawned, undefined).pipe(
              Effect.as(
                makeRunningProcess(() => {
                  tunnelKilled = true;
                }),
              ),
            )
          : Effect.succeed(makeSuccessfulProcess('{"remotePort":3773}\n')),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, hangingHttpClient),
        Layer.succeed(
          NetService.NetService,
          NetService.NetService.of({
            ...testNetService,
            hasListenerOnHost: () => Effect.succeed(false),
          }),
        ),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const ensure = yield* Effect.forkChild(
          Effect.result(
            manager.ensureEnvironment({
              alias: "devbox",
              hostname: "devbox",
              username: null,
              port: null,
            }),
          ),
        );
        yield* Deferred.await(tunnelSpawned);
        yield* TestClock.adjust(Duration.minutes(2));
        const result = yield* Fiber.join(ensure);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, SshReadinessError);
          assert.include(result.failure.message, "SSH connection to devbox did not come up");
        }
        assert.isTrue(tunnelKilled);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect.each([
    {
      name: "does not ask for a password when the agent cannot sign an accepted key",
      stderr:
        'sign_and_send_pubkey: signing failed for ED25519 "/home/julius/.ssh/id_ed25519" from agent: communication with agent failed\r\n' +
        "julius@devbox: Permission denied (publickey,password).\r\n",
      expectedPromptAttempts: [],
    },
    {
      name: "asks for a password when signing failure has no agent provenance",
      stderr:
        'sign_and_send_pubkey: signing failed for ED25519-CERT "key-cert.pub": agent refused operation\n' +
        "julius@devbox: Permission denied (publickey,password).\n",
      expectedPromptAttempts: [1],
    },
    {
      name: "does not ask for a password when the host key cannot be verified",
      stderr: "Host key verification failed.\r\n",
      expectedPromptAttempts: [],
    },
    {
      name: "asks for a password when the server rejects every key",
      stderr: "julius@devbox: Permission denied (publickey,password).\r\n",
      expectedPromptAttempts: [1],
    },
  ])("$name", ({ stderr, expectedPromptAttempts }) =>
    Effect.gen(function* () {
      const promptAttempts: Array<number> = [];
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.succeed(
          commandArgs(command).includes("-G")
            ? makeSuccessfulProcess("")
            : {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(255)),
                stderr: Stream.make(new TextEncoder().encode(stderr)),
              },
        ),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, testHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        Layer.succeed(
          SshAuth.SshPasswordPrompt,
          SshAuth.SshPasswordPrompt.of({
            isAvailable: true,
            request: (request) =>
              Effect.sync(() => {
                promptAttempts.push(request.attempt);
                return null;
              }),
          }),
        ),
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const result = yield* Effect.result(
          manager.ensureEnvironment({
            alias: "devbox",
            hostname: "devbox",
            username: null,
            port: null,
          }),
        );
        assert.isTrue(Result.isFailure(result));
        assert.deepEqual(promptAttempts, expectedPromptAttempts);
        if (Result.isFailure(result)) {
          if (expectedPromptAttempts.length === 0) {
            assert.instanceOf(result.failure, SshCommandError);
            if (isSshCommandError(result.failure)) {
              assert.equal(result.failure.stderr, stderr);
            }
          } else {
            assert.instanceOf(result.failure, SshPasswordPromptError);
          }
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect.each(["local tunnel", "remote server"] as const)(
    "waits for %s shutdown before reconnecting the same target",
    (stalledStep) =>
      Effect.gen(function* () {
        const shutdownStarted = yield* Deferred.make<void>();
        const finishShutdown = yield* Deferred.make<void>();
        const reconnectsStarted = yield* Deferred.make<void>();
        const pauseShutdown = Deferred.succeed(shutdownStarted, undefined).pipe(
          Effect.andThen(Deferred.await(finishShutdown)),
        );
        let resolutions = 0;
        let launches = 0;
        let tunnels = 0;
        let stops = 0;
        let remoteRunning = false;
        const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const args = commandArgs(command);
            const isTarget = args.includes(target.alias);
            if (args.includes("-G")) {
              if (isTarget && ++resolutions === 4) {
                yield* Deferred.succeed(reconnectsStarted, undefined);
              }
              return makeSuccessfulProcess("");
            }
            if (args.includes("-N")) {
              const tunnel = makeRunningProcess(() => undefined);
              if (isTarget && ++tunnels === 1 && stalledStep === "local tunnel") {
                return {
                  ...tunnel,
                  kill: (options?: ChildProcess.KillOptions) =>
                    pauseShutdown.pipe(Effect.andThen(tunnel.kill(options))),
                };
              }
              return tunnel;
            }
            if (args.some((arg, index) => arg === "-s" && args[index + 1] === "--")) {
              if (isTarget) {
                launches += 1;
                remoteRunning = true;
              }
              return makeSuccessfulProcess('{"remotePort":3773}\n');
            }
            const stop = makeSuccessfulProcess('{"stopped":true}\n');
            if (!isTarget) return stop;
            const pause = ++stops === 1 && stalledStep === "remote server";
            return {
              ...stop,
              exitCode: (pause ? pauseShutdown : Effect.void).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    remoteRunning = false;
                    return ChildProcessSpawner.ExitCode(0);
                  }),
                ),
              ),
            };
          }),
        );
        const layer = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.succeed(HttpClient.HttpClient, testHttpClient),
          Layer.succeed(NetService.NetService, testNetService),
          SshAuth.SshPasswordPrompt.disabledLayer,
          SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
        );
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          yield* manager.ensureEnvironment(target);
          const disconnect = yield* Effect.forkChild(manager.disconnectEnvironment(target));
          yield* Deferred.await(shutdownStarted);
          const firstReconnect = yield* Effect.forkChild(manager.ensureEnvironment(target));
          const secondReconnect = yield* Effect.forkChild(manager.ensureEnvironment(target));
          yield* Deferred.await(reconnectsStarted);

          yield* manager.ensureEnvironment({
            alias: "other",
            hostname: "other",
            username: null,
            port: null,
          });
          yield* TestClock.adjust(Duration.zero);
          const launchesBeforeShutdown = launches;
          yield* Deferred.succeed(finishShutdown, undefined);
          yield* Fiber.join(disconnect);
          const first = yield* Fiber.join(firstReconnect);
          const second = yield* Fiber.join(secondReconnect);

          assert.equal(launchesBeforeShutdown, 1);
          assert.equal(launches, 2);
          assert.equal(tunnels, 2);
          assert.isTrue(remoteRunning);
          assert.equal(first.httpBaseUrl, second.httpBaseUrl);
        }).pipe(
          Effect.ensuring(Deferred.succeed(finishShutdown, undefined)),
          Effect.provide(layer),
          Effect.scoped,
        );
      }),
  );

  it.live("concurrent launches on one remote home record the server that owns it", () =>
    // The second row's server never publishes server-runtime.json.
    Effect.forEach([1_500, null], (publishDelayMs) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-launch-" });
        const serversFile = path.join(home, "servers");
        yield* Effect.addFinalizer(() =>
          fs.readFileString(serversFile).pipe(
            Effect.map((pids) => {
              for (const pid of pids.split("\n").filter(Boolean)) {
                try {
                  process.kill(Number(pid), "SIGKILL");
                } catch {}
              }
            }),
            Effect.ignore,
          ),
        );
        const serverScript = path.join(home, "fake-t3.cjs");
        yield* fs.writeFileString(serverScript, fakeT3Serve(publishDelayMs));
        // A launch that died holding the lock must not block or double-admit later ones.
        const launchLock = path.join(home, ".kinako", "ssh-launch", ".launch.lock");
        yield* fs.makeDirectory(path.dirname(launchLock), { recursive: true });
        yield* fs.writeFileString(launchLock, "999999999\n");
        const targets = [
          { alias: "devbox", hostname: "devbox", username: null, port: null },
          { alias: "devbox-tailnet", hostname: "devbox-tailnet", username: null, port: null },
        ];

        const launches = yield* Effect.forEach(
          targets,
          (target) =>
            SshTunnel.launchOrReuseRemoteServer(target, undefined, {
              nodeScriptPath: serverScript,
            }),
          { concurrency: "unbounded" },
        ).pipe(Effect.provide(localRemoteShellLayer(home)));

        const ownerPid = Number(
          yield* fs.readFileString(path.join(home, ".kinako", "userdata", "server.lock")),
        );
        // Every route shares one server record, so the later launch reuses the first one's server.
        assert.deepEqual(
          launches.map((launch) => launch.remoteServerKind),
          ["managed", "managed"],
        );
        assert.equal(launches[0]!.remotePort, launches[1]!.remotePort);
        assert.deepEqual((yield* fs.readFileString(serversFile)).trim().split("\n"), [
          String(ownerPid),
        ]);
        const recordedPid = yield* fs.readFileString(
          path.join(home, ".kinako", "ssh-launch", "server", "pid"),
        );
        assert.equal(Number(recordedPid.trim()), ownerPid);
        assert.isFalse(yield* fs.exists(launchLock));
      }).pipe(Effect.scoped),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
});

describe("remote server ownership", () => {
  const windowsHost = HostProcess.Platform.defaultValue() === "win32";
  const archiveVersion = "1.2.3-preview.20260911.4";
  const routeA = "aaaaaaaaaaaaaaaa";
  const routeB = "bbbbbbbbbbbbbbbb";

  // Stands in for the release executable. It answers the launch script's
  // helpers without touching the network: a server is "ready" once it has
  // dropped a marker file for its port, and each server it starts leaves a
  // `started.<pid>` file naming how it was started.
  const FAKE_EXECUTABLE = String.raw`#!/bin/sh
set -eu
case "$1" in
  --version) echo "kinako fake" ;;
  __ssh-helper)
    case "$2" in
      pick-port) cat "$3" 2>/dev/null || printf '%s' "$4" ;;
      wait-ready)
        ticks=$(($4 / 100))
        while [ ! -f "$HOME/ready/$3" ]; do
          ticks=$((ticks - 1))
          [ "$ticks" -gt 0 ] || exit 1
          sleep 0.1
        done ;;
      runtime-port)
        pid=$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$3" 2>/dev/null)
        port=$(sed -n 's/.*"port":\([0-9]*\).*/\1/p' "$3" 2>/dev/null)
        [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || exit 1
        printf '%s %s' "$pid" "$port" ;;
      seed-service-state) mkdir -p "$3/runtime" && : > "$3/runtime/seeded" ;;
    esac ;;
  serve | __service-launcher)
    port=$(printenv T3CODE_PORT || true)
    host=$(printenv T3CODE_HOST || true)
    if [ "$1" = serve ]; then host="$3"; port="$5"; fi
    mkdir -p "$HOME/.kinako/userdata" "$HOME/ready"
    printf '{"pid":%s,"port":%s,"origin":"http://127.0.0.1:%s"}' "$$" "$port" "$port" >"$HOME/.kinako/userdata/server-runtime.json"
    printf '%s %s %s %s\n' "$1" "$port" "$(printenv T3CODE_HOME || true)" "$host" >"$HOME/started.$$"
    sleep 300 &
    trap 'rm -f "$HOME/ready/$port"; kill $! 2>/dev/null; exit 0' TERM
    : >"$HOME/ready/$port"
    wait ;;
esac
`;

  const hostPath = process.env.PATH ?? "";
  const run = (home: string, args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make("sh", args, {
          env: { PATH: hostPath, HOME: home },
          extendEnv: false,
        }),
      );
      const text = (stream: typeof child.stdout) =>
        stream.pipe(
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (acc, chunk) => acc + chunk,
          ),
        );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [text(child.stdout), text(child.stderr), child.exitCode.pipe(Effect.map(Number))],
        { concurrency: "unbounded" },
      );
      return { stdout, stderr, exitCode };
    });

  const isAlive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const makeHost = Effect.fn("makeHost")(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-ownership-" });
    const home = `${root}/home`;
    const versionDir = `${home}/.kinako/runtime/versions/${archiveVersion}`;
    const executable = `${versionDir}/kinako`;
    yield* fs.makeDirectory(versionDir, { recursive: true });
    yield* fs.writeFileString(executable, FAKE_EXECUTABLE);
    yield* fs.chmod(executable, 0o755);
    yield* fs.writeFileString(`${versionDir}/.install-complete`, `${archiveVersion}\n`);
    yield* fs.writeFileString(
      `${root}/launch.sh`,
      yield* captureRemoteScript(
        SshTunnel.launchOrReuseRemoteServer(SSH_TARGET, undefined, ARCHIVE),
        '{"remotePort":3773}\n',
      ),
    );

    const servers = Effect.gen(function* () {
      const entries = yield* fs.readDirectory(home);
      return yield* Effect.forEach(
        entries.filter((entry) => entry.startsWith("started.")),
        (entry) =>
          fs.readFileString(`${home}/${entry}`).pipe(
            Effect.map((contents) => {
              const [mode, port, t3Home, bindHost] = contents.trim().split(" ");
              const pid = Number(entry.slice("started.".length));
              return { pid, mode, port: Number(port), t3Home, bindHost, alive: isAlive(pid) };
            }),
          ),
      );
    });
    yield* Effect.addFinalizer(() =>
      servers.pipe(
        Effect.tap((all) =>
          Effect.sync(() => {
            for (const server of all) if (server.alive) process.kill(server.pid, "SIGTERM");
          }),
        ),
        Effect.ignore,
      ),
    );

    const launch = (stateKey: string) =>
      run(home, [`${root}/launch.sh`, stateKey]).pipe(
        Effect.map((result) => {
          assert.equal(result.exitCode, 0, result.stderr);
          return JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "") as {
            remotePort: number;
            serverKind: string;
            networkAccess: boolean;
          };
        }),
      );
    const stop = (stateKey: string) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(`${root}/stop.sh`, SshTunnel.buildRemoteStopScript(stateKey));
        const result = yield* run(home, [`${root}/stop.sh`]);
        assert.equal(result.exitCode, 0, result.stderr);
      });
    const untilReady = (port: number) =>
      run(home, ["-c", `"${executable}" __ssh-helper wait-ready ${port} 10000`]).pipe(
        Effect.map((result) => assert.equal(result.exitCode, 0, result.stderr)),
      );
    const setNetworkAccess = (enabled: boolean) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(
          `${root}/network-access.sh`,
          SshTunnel.buildRemoteNetworkAccessScript(enabled),
        );
        const result = yield* run(home, [`${root}/network-access.sh`]);
        assert.equal(result.exitCode, 0, result.stderr);
      });
    return {
      fs,
      home,
      executable,
      launch,
      stop,
      servers,
      run,
      untilReady,
      setNetworkAccess,
    };
  });

  it.live.skipIf(windowsHost)(
    "runs archive servers under the service launcher and shares them across routes",
    () =>
      Effect.gen(function* () {
        const host = yield* makeHost();

        const first = yield* host.launch(routeA);
        assert.equal(first.serverKind, "managed");
        const [server] = yield* host.servers;
        assert.equal(server?.mode, "__service-launcher");
        assert.equal(server?.port, first.remotePort);
        assert.equal(server?.t3Home, `${host.home}/.kinako`);
        assert.isTrue(yield* host.fs.exists(`${host.home}/.kinako/runtime/seeded`));

        // Reconnecting, from the same route or another one, reuses the
        // server instead of restarting it.
        assert.deepEqual(yield* host.launch(routeA), first);
        assert.deepEqual(yield* host.launch(routeB), first);
        const afterReconnects = yield* host.servers;
        assert.equal(afterReconnects.length, 1);
        assert.isTrue(afterReconnects[0]?.alive);

        // Only the route that started it stops it.
        yield* host.stop(routeB);
        assert.isTrue((yield* host.servers)[0]?.alive);
        yield* host.stop(routeA);
        assert.isFalse((yield* host.servers)[0]?.alive);
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.live.skipIf(windowsHost)(
    "moves a server an older launcher started onto the service launcher from any route",
    () =>
      Effect.gen(function* () {
        const host = yield* makeHost();
        const legacy = yield* host.run(host.home, [
          "-c",
          `nohup "${host.executable}" serve --host 127.0.0.1 --port 4100 --base-dir "$HOME/.kinako" >/dev/null 2>&1 & echo $!`,
        ]);
        const legacyPid = Number(legacy.stdout.trim());
        yield* host.untilReady(4100);
        // Route A started it; route B found it running and recorded it as external.
        const launchDir = `${host.home}/.kinako/ssh-launch`;
        yield* host.fs.makeDirectory(`${launchDir}/${routeA}`, { recursive: true });
        yield* host.fs.writeFileString(`${launchDir}/${routeA}/pid`, `${legacyPid}\n`);
        yield* host.fs.writeFileString(`${launchDir}/${routeA}/port`, "4100\n");
        yield* host.fs.writeFileString(`${launchDir}/${routeA}/managed`, "managed\n");
        yield* host.fs.makeDirectory(`${launchDir}/${routeB}`, { recursive: true });
        yield* host.fs.writeFileString(`${launchDir}/${routeB}/port`, "4100\n");
        yield* host.fs.writeFileString(`${launchDir}/${routeB}/managed`, "external\n");

        const result = yield* host.launch(routeB);
        assert.deepEqual(result, { remotePort: 4100, serverKind: "managed", networkAccess: false });
        const servers = yield* host.servers;
        assert.isFalse(servers.find((server) => server.pid === legacyPid)?.alive);
        const replacement = servers.find((server) => server.pid !== legacyPid);
        assert.equal(replacement?.mode, "__service-launcher");
        assert.isTrue(replacement?.alive);

        // Route B restarted it, so route A no longer stops it.
        yield* host.stop(routeA);
        assert.isTrue((yield* host.servers).find((server) => server.pid !== legacyPid)?.alive);
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.live.skipIf(windowsHost)(
    "treats a recorded server pid that another process now holds as stale",
    () =>
      Effect.gen(function* () {
        const host = yield* makeHost();
        const other = yield* host.run(host.home, [
          "-c",
          "nohup sleep 300 >/dev/null 2>&1 & echo $!",
        ]);
        const otherPid = Number(other.stdout.trim());
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (isAlive(otherPid)) process.kill(otherPid, "SIGTERM");
          }),
        );
        // What a server leaves behind when the host reboots and its pid is reused.
        const serverDir = `${host.home}/.kinako/ssh-launch/server`;
        const writeStaleRecord = Effect.forEach(
          Object.entries({
            pid: String(otherPid),
            port: "4400",
            mode: "launcher",
            owner: routeA,
            host: "127.0.0.1",
            started: "Thu Jan  1 00:00:00 1970",
          }),
          ([name, value]) => host.fs.writeFileString(`${serverDir}/${name}`, `${value}\n`),
        );
        yield* host.fs.makeDirectory(serverDir, { recursive: true });

        yield* writeStaleRecord;
        yield* host.stop(routeA);
        assert.isTrue(isAlive(otherPid));

        // Launchers that saved no start time, with a host-wide and a per-route record.
        yield* writeStaleRecord;
        yield* host.fs.remove(`${serverDir}/started`);
        yield* host.stop(routeA);
        assert.isTrue(isAlive(otherPid));
        const legacyDir = `${host.home}/.kinako/ssh-launch/${routeB}`;
        yield* host.fs.makeDirectory(legacyDir, { recursive: true });
        yield* host.fs.writeFileString(`${legacyDir}/pid`, `${otherPid}\n`);
        yield* host.fs.writeFileString(`${legacyDir}/managed`, "managed\n");
        yield* host.stop(routeB);
        assert.isTrue(isAlive(otherPid));

        yield* writeStaleRecord;
        const result = yield* host.launch(routeA);
        assert.deepEqual(result, { remotePort: 4400, serverKind: "managed", networkAccess: false });
        assert.isTrue((yield* host.servers)[0]?.alive);
        assert.isTrue(isAlive(otherPid));
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.live.skipIf(windowsHost)(
    "relaunches its server on the network when the host enables network access",
    () =>
      Effect.gen(function* () {
        const host = yield* makeHost();
        const local = yield* host.launch(routeA);
        assert.isFalse(local.networkAccess);
        const [localServer] = yield* host.servers;
        assert.equal(localServer?.bindHost, "127.0.0.1");

        yield* host.setNetworkAccess(true);
        const exposed = yield* host.launch(routeA);
        assert.deepEqual(exposed, { ...local, networkAccess: true });
        const afterEnable = yield* host.servers;
        assert.isFalse(afterEnable.find((server) => server.pid === localServer?.pid)?.alive);
        const exposedServer = afterEnable.find((server) => server.alive);
        assert.equal(exposedServer?.bindHost, "0.0.0.0");

        // Another route follows the host's preference instead of undoing it.
        assert.deepEqual(yield* host.launch(routeB), exposed);
        assert.equal((yield* host.servers).filter((server) => server.alive).length, 1);

        yield* host.setNetworkAccess(false);
        assert.deepEqual(yield* host.launch(routeB), local);
        const live = (yield* host.servers).filter((server) => server.alive);
        assert.equal(live.length, 1);
        assert.equal(live[0]?.bindHost, "127.0.0.1");
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.live.skipIf(windowsHost)(
    "leaves a server it did not start on loopback when network access is enabled",
    () =>
      Effect.gen(function* () {
        const host = yield* makeHost();
        yield* host.run(host.home, [
          "-c",
          `T3CODE_PORT=4300 nohup "${host.executable}" __service-launcher >/dev/null 2>&1 &`,
        ]);
        yield* host.untilReady(4300);
        yield* host.setNetworkAccess(true);

        assert.deepEqual(yield* host.launch(routeA), {
          remotePort: 4300,
          serverKind: "external",
          networkAccess: false,
        });
        assert.equal((yield* host.servers).length, 1);
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
});

// On Linux kill -0 accepts a thread ID and kill <tid> signals its whole process,
// but ps lists only thread-group leaders. After a reboot the managed pid file can
// name a thread or a whole process that is not our server.
describe.runIf(HostProcess.Platform.defaultValue() === "linux")("stale managed pid file", () => {
  const FAKE_SERVER = `const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const server = http.createServer((_request, response) => response.end("ok"));
server.listen(Number(flag("--port") ?? 0), "127.0.0.1", () => {
  const port = server.address().port;
  const base = flag("--base-dir");
  if (base) {
    fs.mkdirSync(path.join(base, "userdata"), { recursive: true });
    fs.writeFileSync(
      path.join(base, "userdata", "server-runtime.json"),
      JSON.stringify({ version: 1, pid: process.pid, port, origin: "http://127.0.0.1:" + port }),
    );
  }
  console.log(port);
});
`;
  const target = { alias: "devbox", hostname: "devbox", username: null, port: null } as const;
  const staleIds = ["a thread of an unrelated process", "an unrelated process"] as const;

  const isRunning = (pid: number) =>
    Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(`/proc/${pid}/stat`)).pipe(
      Effect.map((stat) => !/^\d+ \(.*\) Z/u.test(stat)),
      Effect.orElseSucceed(() => false),
    );

  const prepare = (staleId: (typeof staleIds)[number]) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-stale-pid-" });
      const home = `${root}/home`;
      const fakeServer = `${root}/fake-t3.cjs`;
      yield* fs.makeDirectory(home, { recursive: true });
      yield* fs.writeFileString(fakeServer, FAKE_SERVER);
      // Runs the remote command locally under the temp HOME, without -l so the test
      // machine's login profile cannot move HOME. setsid keeps a launched server alive
      // when the command's process group goes away, as sshd would.
      const sshAsLocalShell = ChildProcessSpawner.make((command) => {
        if (command._tag !== "StandardCommand" || command.command !== "ssh") {
          return realSpawner.spawn(command);
        }
        if (command.args.includes("-G")) return Effect.succeed(makeSuccessfulProcess(""));
        const remoteArgs = command.args.slice(command.args.indexOf("--") + 2);
        return realSpawner.spawn(
          ChildProcess.make("setsid", ["-w", ...remoteArgs.filter((arg) => arg !== "-l")], {
            ...command.options,
            env: { PATH: process.env.PATH ?? "", HOME: home },
            extendEnv: false,
          }),
        );
      });
      const holder = yield* realSpawner.spawn(ChildProcess.make("node", [fakeServer]));
      const holderPort = Number(
        Option.getOrThrow(
          yield* holder.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runHead),
        ),
      );
      const tid = Number(
        (yield* fs.readDirectory(`/proc/${holder.pid}/task`)).find(
          (task) => task !== `${holder.pid}`,
        ),
      );
      assert.isTrue(Number.isInteger(tid));
      return {
        fs,
        home,
        fakeServer,
        holder,
        holderPort,
        sshAsLocalShell,
        staleId: staleId === "an unrelated process" ? holder.pid : tid,
        stateKey: yield* remoteStateKey(target),
        serverDir: `${home}/.kinako/ssh-launch/server`,
      };
    });

  it.live.each(staleIds)("launches a fresh server when the managed pid file names %s", (kind) =>
    Effect.gen(function* () {
      const { fs, home, fakeServer, holderPort, sshAsLocalShell, staleId, serverDir } =
        yield* prepare(kind);
      const launch = SshTunnel.launchOrReuseRemoteServer(target, undefined, {
        nodeScriptPath: fakeServer,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, sshAsLocalShell));
      const readPid = fs
        .readFileString(`${serverDir}/pid`)
        .pipe(Effect.map((pid) => Number(pid.trim())));
      const launchedPids: Array<number> = [];
      yield* Effect.addFinalizer(() =>
        Effect.forEach(launchedPids, (pid) =>
          Effect.sync(() => {
            try {
              process.kill(pid, "SIGKILL");
            } catch {}
          }),
        ),
      );

      const first = yield* launch;
      const firstPid = yield* readPid;
      launchedPids.push(firstPid);
      assert.deepEqual(yield* launch, first);
      assert.equal(yield* readPid, firstPid);

      // Reboot: our server is gone and its recorded PID now names something that
      // answers on the recorded port.
      process.kill(firstPid, "SIGKILL");
      yield* fs.remove(`${home}/.kinako/userdata/server-runtime.json`);
      yield* fs.writeFileString(`${serverDir}/pid`, `${staleId}\n`);
      yield* fs.writeFileString(`${serverDir}/port`, `${holderPort}\n`);
      yield* fs.writeFileString(`${serverDir}/started`, "Thu Jan  1 00:00:00 1970\n");

      const relaunched = yield* launch;
      const pid = yield* readPid;
      if (pid !== staleId) launchedPids.push(pid);
      assert.notEqual(
        relaunched.remotePort,
        holderPort,
        `the launcher kept ${kind} as its running server`,
      );
      assert.isTrue(yield* isRunning(pid));
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.live.each(staleIds)("disconnecting does not signal %s named by the managed pid file", (kind) =>
    Effect.gen(function* () {
      const { fs, holder, sshAsLocalShell, staleId, stateKey, serverDir } = yield* prepare(kind);
      yield* fs.makeDirectory(serverDir, { recursive: true });
      yield* fs.writeFileString(`${serverDir}/pid`, `${staleId}\n`);
      yield* fs.writeFileString(`${serverDir}/owner`, `${stateKey}\n`);
      yield* fs.writeFileString(`${serverDir}/started`, "Thu Jan  1 00:00:00 1970\n");
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, sshAsLocalShell),
        Layer.succeed(HttpClient.HttpClient, testHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );

      yield* Effect.flatMap(SshTunnel.SshEnvironmentManager, (manager) =>
        manager.disconnectEnvironment(target),
      ).pipe(Effect.provide(layer));
      assert.isTrue(yield* isRunning(holder.pid), `disconnecting signalled ${kind}`);
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
});

// On macOS, Node can bind 127.0.0.1:<port> while another process (such as the
// desktop app with network access on) listens on *:<port>. Linux refuses that
// bind unless both sockets set SO_REUSEPORT, so on Linux the preload adds it to
// the picker's probe and the holder sets it too.
