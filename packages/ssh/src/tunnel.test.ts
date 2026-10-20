import * as NodeNet from "node:net";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthStandardClientScopes } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as SshAuth from "./auth.ts";
import { SshCommandError } from "./errors.ts";
import * as SshTunnel from "./tunnel.ts";

const TEST_NODE_ENGINE_RANGE = "^22.16 || ^23.11 || >=24.10";

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

const makeDelayedSuccessfulProcess = (stdout: string, delayMs: number) => {
  const process = makeSuccessfulProcess(stdout);
  return {
    ...process,
    exitCode: Effect.sleep(Duration.millis(delayMs)).pipe(
      Effect.as(ChildProcessSpawner.ExitCode(0)),
    ),
  };
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
  hasListenerOnHost: () => Effect.succeed(false),
  reserveLoopbackPort: () => Effect.succeed(41_773),
  findAvailablePort: (preferred) => Effect.succeed(preferred),
});

function commandArgs(command: ChildProcess.Command): ReadonlyArray<string> {
  return command._tag === "StandardCommand" ? command.args : [];
}

const ARCHIVE = { archiveVersion: "1.2.3-preview.20260911.4" } as const;
const NODE_SCRIPT = {
  nodeScriptPath: "/Users/julius/Development/Work/codething-mvp/apps/server/dist/bin.mjs",
} as const;

describe("ssh tunnel scripts", () => {
  it("installs and runs the release archive without Node, npm, or npx", () => {
    const script = SshTunnel.buildRemoteT3RunnerScript(ARCHIVE);

    assert.include(script, "T3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'");
    assert.include(script, "T3_NODE_SCRIPT_PATH=''");
    assert.include(
      script,
      "T3_RELEASE_BASE_URL='https://github.com/niranjan94/kinako/releases/download'",
    );
    assert.include(script, 'T3_RUNTIME_DIR="$HOME/.kinako/runtime/versions/$T3_ARCHIVE_VERSION"');
    assert.include(script, 'T3_ARCHIVE="kinako-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz"');
    assert.include(script, "SHA256SUMS");
    assert.include(script, 'exec "$T3_RUNTIME_DIR/kinako" "$@"');
    assert.notInclude(script, "npx");
    assert.notInclude(script, "npm exec");
    assert.notInclude(script, "t3@latest");
    assert.notInclude(script, 'exec t3 "$@"');
    assert.include(
      script,
      'T3_LOCK="$HOME/.kinako/runtime/versions/.$T3_ARCHIVE_VERSION.install.lock"',
    );
    assert.include(script, 'if ! kill -0 "$T3_LOCK_OWNER" 2>/dev/null; then');
    assert.include(script, 'if [ "$T3_LOCK_UNOWNED" -ge 5 ]; then');
    assert.include(script, 'if [ "$T3_LOCK_WAITED" -ge 360 ]; then');
    assert.include(script, '"$T3_STAGING/SHA256SUMS" 30');
    assert.include(script, '"$T3_STAGING/$T3_ARCHIVE" 240');
    assert.notInclude(script, "T3_LOCK_CANDIDATE");
    assert.notInclude(script, "-mmin");
    assert.equal(script.split("if ! t3_runtime_ready; then").length - 1, 2);
    assert.isBelow(
      script.indexOf('"$T3_STAGING/kinako" --version'),
      script.indexOf('> "$T3_STAGING/.install-complete"'),
    );
    assert.equal(script.split("ensure_remote_node_path || true").length - 1, 1);
    assert.isBelow(
      script.indexOf("ensure_remote_node_path || true"),
      script.indexOf('exec node "$T3_NODE_SCRIPT_PATH" "$@"'),
    );
    assert.isBelow(
      script.indexOf('exec node "$T3_NODE_SCRIPT_PATH" "$@"'),
      script.indexOf("T3_ARCHIVE_VERSION="),
    );

    const launch = SshTunnel.buildRemoteLaunchScript({
      ...ARCHIVE,
      releaseBaseUrl: "https://mirror.example/t3/",
    });
    assert.include(launch, "T3_ARCHIVE_MODE=1");
    assert.include(launch, "T3_RELEASE_BASE_URL='https://mirror.example/t3'");
    assert.include(launch, '"$RUNNER_FILE" __ssh-helper pick-port "$PORT_FILE"');
    assert.include(launch, '"$RUNNER_FILE" __ssh-helper wait-ready "$REMOTE_PORT"');
    assert.include(launch, '"$RUNNER_FILE" __ssh-helper runtime-port "$DEFAULT_RUNTIME_FILE"');
    assert.include(SshTunnel.buildRemoteLaunchScript(NODE_SCRIPT), "T3_ARCHIVE_MODE=0");
  });

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

  it("refuses to build a runner with neither an archive version nor a node script", () => {
    for (const input of [undefined, {}, { archiveVersion: "  " }, { nodeScriptPath: null }]) {
      assert.throws(
        () => SshTunnel.buildRemoteT3RunnerScript(input),
        SshTunnel.SshMissingRunnerError,
      );
    }
    assert.throws(() => SshTunnel.buildRemoteLaunchScript(), SshTunnel.SshMissingRunnerError);
  });

  it("does not hard-code a remote node engine range", () => {
    const script = SshTunnel.buildRemoteT3RunnerScript(NODE_SCRIPT);

    assert.include(script, "T3_NODE_ENGINE_RANGE=''");
    assert.notInclude(script, TEST_NODE_ENGINE_RANGE);
  });

  it("builds the remote t3 runner with a node script override", () => {
    const script = SshTunnel.buildRemoteT3RunnerScript({
      ...NODE_SCRIPT,
      nodeEngineRange: TEST_NODE_ENGINE_RANGE,
    });

    assert.include(
      script,
      "T3_NODE_SCRIPT_PATH='/Users/julius/Development/Work/codething-mvp/apps/server/dist/bin.mjs'",
    );
    assert.include(script, 'exec node "$T3_NODE_SCRIPT_PATH" "$@"');
    assert.include(script, "T3_ARCHIVE_VERSION=''");
    assert.include(script, 'prepend_path_if_dir "$HOME/.local/bin"');
    assert.include(script, `T3_NODE_ENGINE_RANGE='${TEST_NODE_ENGINE_RANGE}'`);
    assert.include(script, "remote_node_satisfies_engine()");
    assert.include(script, "function satisfiesSemverRange");
    assert.include(script, "satisfiesSemverRange(rawVersion, range)");
    assert.include(script, 'prepend_path_if_dir "/home/linuxbrew/.linuxbrew/bin"');
    assert.include(script, 'prepend_path_if_dir "$VOLTA_HOME/bin"');
    assert.include(script, 'prepend_path_if_dir "$HOME/.asdf/shims"');
    assert.include(script, 'prepend_path_if_dir "$HOME/.local/share/mise/shims"');
    assert.include(script, 'eval "$(fnm env --shell bash)"');
    assert.include(script, "fnm use --silent-if-unchanged");
    assert.include(script, "fnm use default");
    assert.include(script, 'prepend_path_if_dir "$HOME/.nodenv/shims"');
    assert.include(script, 'NVM_DIR="$HOME/.nvm"');
    assert.include(script, "nvm use --silent default");
    assert.include(script, 'for T3_NODE_BIN in "$NVM_DIR"/versions/node/*/bin');
    assert.notInclude(script, "ensure $NVM_DIR/nvm.sh is available");
    assert.notInclude(script, "npx");
  });

  it("embeds the runner in the launch script byte for byte", () => {
    const runner = SshTunnel.buildRemoteT3RunnerScript(ARCHIVE);
    assert.include(SshTunnel.buildRemoteLaunchScript(ARCHIVE), runner);
  });

  it("uses the remote t3 runner for launch and pairing scripts", () => {
    const stateKey = "711bc738002d72fd";
    const launch = SshTunnel.buildRemoteLaunchScript(ARCHIVE);
    const devLaunch = SshTunnel.buildRemoteLaunchScript({
      ...NODE_SCRIPT,
      nodeEngineRange: TEST_NODE_ENGINE_RANGE,
    });

    assert.include(launch, "ensure_remote_node_path()");
    assert.include(launch, "if ! ensure_remote_node_path; then");
    assert.include(devLaunch, `T3_NODE_ENGINE_RANGE='${TEST_NODE_ENGINE_RANGE}'`);
    assert.include(devLaunch, "does not satisfy required range ");
    assert.include(devLaunch, '"$RUNNER_FILE" serve --host "$BIND_HOST"');
    assert.include(launch, "T3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'");
    const pairing = SshTunnel.buildRemotePairingScript(stateKey, ARCHIVE);
    assert.match(
      pairing,
      /^"\$RUNNER_FILE" auth pairing create --base-dir "\$PAIRING_BASE_DIR"( --scope \S+)+ --json$/m,
    );
    assert.include(pairing, 'PAIRING_BASE_DIR="$DEFAULT_SERVER_HOME"');
    assert.notInclude(pairing, "server-home");
    const pairingScopes = [...pairing.matchAll(/--scope (\S+)/g)].map((match) => match[1]);
    assert.deepStrictEqual(pairingScopes, [...AuthStandardClientScopes]);
    assert.include(pairing, "T3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'");
  });

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
    const layerProcess = Layer.merge(NodeServices.layer, layerSpawner);

    return Effect.gen(function* () {
      const result = yield* SshTunnel.launchOrReuseRemoteServer(target, undefined, ARCHIVE);
      assert.equal(result.remotePort, 3774);
      assert.deepEqual(spawnedCommands[0]?.slice(-5, -1), ["sh", "-l", "-s", "--"]);
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect("allows cold remote launches to exceed the default SSH command timeout", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(makeDelayedSuccessfulProcess('{"remotePort":3774}\n', 75_000)),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.mergeAll(NodeServices.layer, layerSpawner, TestClock.layer());

    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        SshTunnel.launchOrReuseRemoteServer(target, undefined, NODE_SCRIPT),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(75));

      const result = yield* Fiber.join(fiber);
      assert.equal(result.remotePort, 3774);
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect("gives cold archive launches a larger budget than node-script launches", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(makeDelayedSuccessfulProcess('{"remotePort":3774}\n', 800_000)),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.mergeAll(NodeServices.layer, layerSpawner, TestClock.layer());

    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        SshTunnel.launchOrReuseRemoteServer(target, undefined, ARCHIVE),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(800));

      const result = yield* Fiber.join(fiber);
      assert.equal(result.remotePort, 3774);
    }).pipe(Effect.provide(layerProcess));
  });

  it("allows the remote port picker to run without a state file path", () => {
    assert.include(SshTunnel.REMOTE_PICK_PORT_SCRIPT, 'const filePath = process.argv[2] ?? "";');
  });

  it.effect("bounds each HTTP readiness probe so retries cannot hang on one request", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Effect.result(
          SshTunnel.waitForHttpReady({
            baseUrl: "http://127.0.0.1:41773/",
            timeoutMs: 1_000,
            intervalMs: 100,
            probeTimeoutMs: 250,
          }),
        ),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(1_000));

      const result = yield* Fiber.join(fiber);

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.include(result.failure.message, "Timed out waiting 1000ms");
      }
    }).pipe(
      Effect.provide(
        Layer.merge(TestClock.layer(), Layer.succeed(HttpClient.HttpClient, hangingHttpClient)),
      ),
    ),
  );

  it("preserves primitive readiness reason values in diagnostic output", () => {
    assert.deepEqual(
      SshTunnel.describeReadinessCause({
        _tag: "HttpClientError",
        message: "Backend readiness probe failed.",
        reason: "authentication failed",
        cause: "upstream closed",
      }),
      {
        _tag: "HttpClientError",
        message: "Backend readiness probe failed.",
        reason: "authentication failed",
        cause: "upstream closed",
      },
    );
  });

  it.effect("accepts pretty-printed pairing JSON from the remote CLI", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeSuccessfulProcess(`{
  "id": "88941235-6ed5-4184-a2ff-5339e2075958",
  "credential": "LCL4R2TPHDKQ",
  "scopes": ["orchestration:read"],
  "expiresAt": "2026-04-29T01:01:20.994Z"
}

`),
      ),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.merge(NodeServices.layer, layerSpawner);
    return Effect.gen(function* () {
      const result = yield* SshTunnel.issueRemotePairingToken(target, undefined, ARCHIVE);
      assert.equal(result.credential, "LCL4R2TPHDKQ");
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
    const layerProcess = Layer.merge(NodeServices.layer, layerSpawner);
    return Effect.gen(function* () {
      const result = yield* SshTunnel.issueRemotePairingToken(target, undefined, ARCHIVE);
      assert.equal(result.credential, "LCL4R2TPHDKQ");
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect("replaces a stale SSH forward without stopping the remote server", () =>
    Effect.gen(function* () {
      const probeStarted = yield* Deferred.make<void>();
      let stale = false;
      let forwards = 0;
      let stops = 0;
      let kills = 0;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          const args = commandArgs(command);
          if (args.includes("-N")) {
            forwards += 1;
            stale = false;
            return makeRunningProcess(() => {
              kills += 1;
            });
          }
          if (args.some((arg, index) => arg === "-s" && args[index + 1] === "--"))
            return makeSuccessfulProcess('{"remotePort":3773}\n');
          if (args.includes("sh")) stops += 1;
          return makeSuccessfulProcess("");
        }),
      );
      const httpClient = HttpClient.make((request) =>
        stale
          ? Deferred.succeed(probeStarted, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, httpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
        yield* manager.ensureEnvironment(target);
        stale = true;
        const reconnect = yield* Effect.forkChild(manager.ensureEnvironment(target));
        yield* Deferred.await(probeStarted);
        yield* TestClock.adjust("2 seconds");
        yield* Fiber.join(reconnect);
        assert.equal(forwards, 2);
        assert.equal(kills, 1);
        assert.equal(stops, 0);
        yield* manager.disconnectEnvironment(target);
        assert.equal(stops, 1);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

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

  it.effect.each(["successful stop", "failed stop"] as const)(
    "closes the tunnel scope and starts fresh after a %s",
    (mode) => {
      const spawnedCommands: Array<ReadonlyArray<string>> = [];
      let tunnelKillCount = 0;
      let stopCommandCount = 0;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          const args = commandArgs(command);
          spawnedCommands.push(args);
          if (args.includes("-N")) {
            return makeRunningProcess(() => {
              tunnelKillCount += 1;
            });
          }
          if (args.some((arg, index) => arg === "-s" && args[index + 1] === "--")) {
            return makeSuccessfulProcess('{"remotePort":3773}\n');
          }
          if (args.includes("sh")) {
            stopCommandCount += 1;
            if (mode === "failed stop" && stopCommandCount === 1) {
              return {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
                stderr: Stream.make(
                  new TextEncoder().encode("Remote T3 server did not stop within 2 seconds.\n"),
                ),
              };
            }
            return makeSuccessfulProcess('{"stopped":true}\n');
          }
          return makeSuccessfulProcess("\n");
        }),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, testHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      const target = {
        alias: "devbox",
        hostname: "devbox.example.com",
        username: "julius",
        port: 2222,
      } as const;

      return Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;

        const first = yield* manager.ensureEnvironment(target);
        assert.equal(first.httpBaseUrl, "http://127.0.0.1:41773/");
        const firstTunnelArgs = spawnedCommands.find((args) => args.includes("-N"));
        assert.isDefined(firstTunnelArgs);
        assert.include(firstTunnelArgs, "ControlMaster=no");
        assert.include(firstTunnelArgs, "ControlPath=none");
        assert.include(firstTunnelArgs, "ControlPersist=no");
        assert.deepEqual(firstTunnelArgs?.slice(-2), ["--", "julius@devbox"]);

        const disconnected = yield* Effect.result(manager.disconnectEnvironment(target));
        if (mode === "failed stop") {
          assert.isTrue(Result.isFailure(disconnected));
          if (Result.isFailure(disconnected)) {
            assert.instanceOf(disconnected.failure, SshCommandError);
            assert.equal(
              disconnected.failure.message,
              "Remote T3 server did not stop within 2 seconds.",
            );
          }
        } else {
          assert.isTrue(Result.isSuccess(disconnected));
        }
        assert.equal(tunnelKillCount, 1);
        assert.equal(stopCommandCount, 1);

        if (mode === "failed stop") {
          yield* manager.disconnectEnvironment(target);
          assert.equal(tunnelKillCount, 1);
          assert.equal(stopCommandCount, 2);
        }

        yield* manager.ensureEnvironment(target);

        assert.equal(spawnedCommands.filter((args) => args.includes("-N")).length, 2);
        assert.equal(tunnelKillCount, 1);
      }).pipe(
        Effect.provide(layer),
        Effect.scoped,
        Effect.andThen(
          Effect.sync(() => {
            assert.equal(tunnelKillCount, 2);
            assert.equal(stopCommandCount, mode === "failed stop" ? 3 : 2);
          }),
        ),
      );
    },
  );

  it.effect("keeps the stderr reader alive until disconnect", () =>
    Effect.gen(function* () {
      const readerStarted = yield* Deferred.make<void>();
      let readers = 0;
      let finalized = 0;
      const stderr = Stream.fromEffect(
        Effect.sync(() => {
          readers += 1;
        }).pipe(Effect.andThen(Deferred.succeed(readerStarted, undefined))),
      ).pipe(
        Stream.flatMap(() => Stream.fromEffect(Effect.never)),
        Stream.ensuring(
          Effect.sync(() => {
            finalized += 1;
          }),
        ),
      );
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.succeed(
          commandArgs(command).includes("-N")
            ? { ...makeRunningProcess(() => undefined), stderr }
            : makeSuccessfulProcess('{"remotePort":3773}\n'),
        ),
      );
      const httpClient = HttpClient.make((request) =>
        Deferred.await(readerStarted).pipe(
          Effect.as(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
        ),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, httpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
        yield* manager.ensureEnvironment(target);
        assert.equal(readers, 1);
        assert.equal(finalized, 0, "readiness must not release the stderr reader");
        yield* manager.disconnectEnvironment(target);
        assert.equal(finalized, 1, "disconnect must release the stderr reader");
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
          if (result.failure instanceof SshCommandError) {
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
          if (result.failure instanceof SshCommandError) {
            assert.equal(result.failure.exitCode, 255);
            assert.equal(result.failure.stderr, diagnostic);
          }
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.live("drains diagnostics beyond pipe capacity after readiness", () =>
    Effect.gen(function* () {
      const nodeSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const executable = yield* HostProcess.ExecutablePath;
      const input = yield* Queue.unbounded<Uint8Array>();
      const readerStarted = yield* Deferred.make<void>();
      const tunnelSpawned = yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
      let finalized = 0;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!commandArgs(command).includes("-N")) {
            return makeSuccessfulProcess('{"remotePort":3773}\n');
          }
          const child = yield* nodeSpawner.spawn(
            ChildProcess.make(
              executable,
              [
                "-e",
                `process.stdin.once("data", () => {
                process.stderr.write(Buffer.alloc(2 * 1024 * 1024, "x"), () => {
                  process.stdout.write("diagnostics complete\\n");
                });
              });`,
              ],
              { stdin: { stream: Stream.fromQueue(input) } },
            ),
          );
          yield* Deferred.succeed(tunnelSpawned, child);
          return {
            ...child,
            stderr: Stream.fromEffect(Deferred.succeed(readerStarted, undefined)).pipe(
              Stream.flatMap(() => child.stderr),
              Stream.ensuring(
                Effect.sync(() => {
                  finalized += 1;
                }),
              ),
            ),
          };
        }),
      );
      const httpClient = HttpClient.make((request) =>
        Deferred.await(readerStarted).pipe(
          Effect.as(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
        ),
      );
      const layer = Layer.mergeAll(
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, httpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
        yield* manager.ensureEnvironment(target);
        const child = yield* Deferred.await(tunnelSpawned);
        const progress = yield* child.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Queue.offer(input, new TextEncoder().encode("write diagnostics"));
        // The deadline only bounds a blocked subprocess; success waits for its write callback.
        assert.deepEqual(yield* Fiber.join(progress).pipe(Effect.timeout("5 seconds")), [
          "diagnostics complete",
        ]);
        assert.isTrue(yield* child.isRunning);
        yield* manager.disconnectEnvironment(target);
        assert.equal(finalized, 1);
        assert.isFalse(yield* child.isRunning);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
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
});

// On macOS, Node can bind 127.0.0.1:<port> while another process (such as the
// desktop app with network access on) listens on *:<port>. Linux refuses that
// bind unless both sockets set SO_REUSEPORT, so on Linux the preload adds it to
// the picker's probe and the holder sets it too.
const MACOS_BIND_PRELOAD = `const net = require("node:net");
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (port, host, callback) {
  if (typeof port !== "number" || typeof host !== "string") return listen.apply(this, arguments);
  return listen.call(this, { port, host, reusePort: true }, callback);
};
`;

describe("remote port picker", () => {
  const hostPlatform = HostProcess.Platform.defaultValue();
  const linuxHost = hostPlatform === "linux";
  const windowsHost = hostPlatform === "win32";

  const holdWildcardPort = Effect.acquireRelease(
    Effect.callback<NodeNet.Server>((resume) => {
      const server = NodeNet.createServer((socket) => socket.destroy());
      server.once("error", (error) => resume(Effect.die(error)));
      server.listen({ port: 0, host: "0.0.0.0", reusePort: linuxHost }, () =>
        resume(Effect.succeed(server)),
      );
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  );

  it.effect.skipIf(windowsHost)("skips a port another server answers on loopback", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pick-port-" });
      yield* fs.writeFileString(`${root}/preload.cjs`, MACOS_BIND_PRELOAD);
      yield* fs.writeFileString(`${root}/pick-port.cjs`, SshTunnel.REMOTE_PICK_PORT_SCRIPT);
      const holder = yield* holdWildcardPort;
      const heldPort = (holder.address() as NodeNet.AddressInfo).port;

      const child = yield* spawner.spawn(
        ChildProcess.make(process.execPath, [
          ...(linuxHost ? ["--require", `${root}/preload.cjs`] : []),
          `${root}/pick-port.cjs`,
          "",
          String(heldPort),
          "20",
        ]),
      );
      const [stdout, exitCode] = yield* Effect.all(
        [
          child.stdout.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (acc, chunk) => acc + chunk,
            ),
          ),
          child.exitCode.pipe(Effect.map(Number)),
        ],
        { concurrency: "unbounded" },
      );

      assert.equal(exitCode, 0);
      const picked = Number(stdout);
      assert.isAbove(picked, heldPort);
      assert.isBelow(picked, heldPort + 20);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

const runScript = (
  home: string,
  args: ReadonlyArray<string>,
  options?: {
    path?: string;
    stdin?: Stream.Stream<Uint8Array>;
    onStderrLine?: (line: string) => Effect.Effect<void>;
  },
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make("sh", args, {
        env: { PATH: options?.path ?? process.env.PATH ?? "", HOME: home },
        extendEnv: false,
        ...(options?.stdin ? { stdin: { stream: options.stdin } } : {}),
      }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        child.stdout.pipe(
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (acc, chunk) => acc + chunk,
          ),
        ),
        child.stderr.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.tap((line) => options?.onStderrLine?.(line) ?? Effect.void),
          Stream.runFold(
            () => "",
            (acc, line) => `${acc}${line}\n`,
          ),
        ),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );
    return { stdout, stderr, exitCode };
  });

describe("archive runner script", () => {
  const hostPlatform = HostProcess.Platform.defaultValue();
  const hostArch = HostProcess.Architecture.defaultValue();
  const windowsHost = hostPlatform === "win32";
  const archiveVersion = "1.2.3-preview.20260911.4";

  const runRunner = (home: string, runner: string, options?: Parameters<typeof runScript>[2]) =>
    runScript(home, [runner, "--version"], options);

  const makeMirror = Effect.fn("makeMirror")(function* (root: string) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const platform = hostPlatform === "darwin" ? "darwin" : "linux";
    const arch = hostArch === "arm64" ? "arm64" : "x64";
    const stem = `kinako-${archiveVersion}-${platform}-${arch}`;
    const stage = `${root}/stage/${stem}`;
    const release = `${root}/mirror/v${archiveVersion}`;
    const script = [
      "set -eu",
      `mkdir -p '${stage}' '${release}'`,
      `printf '#!/bin/sh\\necho t3 v${archiveVersion}\\n' > '${stage}/kinako'`,
      `chmod +x '${stage}/kinako'`,
      `tar -czf '${release}/${stem}.tar.gz' -C '${root}/stage' '${stem}'`,
      `cd '${release}' && (sha256sum '${stem}.tar.gz' 2>/dev/null || shasum -a 256 '${stem}.tar.gz') > SHA256SUMS`,
    ].join("\n");
    const child = yield* spawner.spawn(ChildProcess.make("sh", ["-c", script]));
    assert.equal(Number(yield* child.exitCode), 0);
    return `file://${root}/mirror`;
  });

  it.effect.skipIf(windowsHost)(
    "installs once when several launches race, and reclaims stale locks",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-archive-runner-" });
        const releaseBaseUrl = yield* makeMirror(root);
        const runner = `${root}/run-t3.sh`;
        yield* fs.writeFileString(
          runner,
          SshTunnel.buildRemoteT3RunnerScript({ archiveVersion, releaseBaseUrl }),
        );
        const home = `${root}/home`;
        yield* fs.makeDirectory(home, { recursive: true });
        // Reproduce mkdir succeeding on EEXIST, even on hosts without the uutils bug.
        const bin = `${root}/bin`;
        yield* fs.makeDirectory(bin);
        for (const [name, script] of Object.entries({
          mkdir: 'PATH=${PATH#*:}\nexec mkdir -p "$@"',
          tar: 'echo >> "${0%/*}/installs"\necho installing >&2\nread -r release\nPATH=${PATH#*:}\nexec tar "$@"',
          sleep: 'echo waiting >&2\nPATH=${PATH#*:}\nexec sleep "$@"',
        })) {
          yield* fs.writeFileString(`${bin}/${name}`, `#!/bin/sh\n${script}\n`);
          yield* fs.chmod(`${bin}/${name}`, 0o755);
        }
        const path = `${bin}:${process.env.PATH ?? ""}`;
        const installing = yield* Deferred.make<void>();
        const contended = yield* Deferred.make<void>();
        // Hold the first extraction until another runner either waits for the lock
        // or incorrectly begins installing. This forces contention without timing assumptions.
        const first = yield* runRunner(home, runner, {
          path,
          stdin: Stream.fromEffect(
            Deferred.await(contended).pipe(Effect.as(new TextEncoder().encode("release\n"))),
          ),
          onStderrLine: (line) =>
            line === "installing"
              ? Deferred.succeed(installing, undefined).pipe(Effect.asVoid)
              : Effect.void,
        }).pipe(Effect.forkChild);
        yield* Deferred.await(installing);
        const contender = runRunner(home, runner, {
          path,
          stdin: Stream.make(new TextEncoder().encode("release\n")),
          onStderrLine: (line) =>
            line === "installing" || line === "waiting"
              ? Deferred.succeed(contended, undefined).pipe(Effect.asVoid)
              : Effect.void,
        });
        const results = yield* Effect.all([Fiber.join(first), contender, contender], {
          concurrency: "unbounded",
        });
        assert.equal(yield* fs.readFileString(`${bin}/installs`), "\n");
        for (const result of results) {
          assert.equal(result.exitCode, 0, result.stderr);
          assert.include(result.stdout, `t3 v${archiveVersion}`);
        }
        const versionsDir = `${home}/.kinako/runtime/versions`;
        assert.deepEqual(yield* fs.readDirectory(versionsDir), [archiveVersion]);
        assert.equal(
          (yield* fs.readFileString(`${versionsDir}/${archiveVersion}/.install-complete`)).trim(),
          archiveVersion,
        );

        const lock = `${versionsDir}/.${archiveVersion}.install.lock`;
        yield* fs.remove(`${versionsDir}/${archiveVersion}`, { recursive: true });
        yield* fs.writeFileString(lock, "999999\n");
        const afterDead = yield* runRunner(home, runner);
        assert.equal(afterDead.exitCode, 0, afterDead.stderr);

        yield* fs.remove(`${versionsDir}/${archiveVersion}`, { recursive: true });
        yield* fs.writeFileString(lock, "");
        const afterUnowned = yield* runRunner(home, runner);
        assert.equal(afterUnowned.exitCode, 0, afterUnowned.stderr);
        assert.isFalse(yield* fs.exists(lock));
      }).pipe(Effect.provide(NodeServices.layer)),
    60_000,
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

  const run = (home: string, args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make("sh", args, {
          env: { PATH: process.env.PATH ?? "", HOME: home },
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
    yield* fs.makeDirectory(versionDir, { recursive: true });
    yield* fs.writeFileString(`${versionDir}/kinako`, FAKE_EXECUTABLE);
    yield* fs.chmod(`${versionDir}/kinako`, 0o755);
    yield* fs.writeFileString(`${versionDir}/.install-complete`, `${archiveVersion}\n`);
    yield* fs.writeFileString(`${root}/launch.sh`, SshTunnel.buildRemoteLaunchScript(ARCHIVE));

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
    // The fake server marks itself ready from a background process.
    const untilReady = (port: number) =>
      fs
        .exists(`${home}/ready/${port}`)
        .pipe(Effect.delay("50 millis"), Effect.repeat({ until: (ready) => ready }));
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
      launchScript: `${root}/launch.sh`,
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
      }).pipe(Effect.provide(NodeServices.layer)),
    30_000,
  );

  it.live.skipIf(windowsHost)(
    "moves a server an older launcher started onto the service launcher from any route",
    () =>
      Effect.gen(function* () {
        const host = yield* makeHost();
        const executable = `${host.home}/.kinako/runtime/versions/${archiveVersion}/kinako`;
        const legacy = yield* host.run(host.home, [
          "-c",
          `nohup "${executable}" serve --host 127.0.0.1 --port 4100 --base-dir "$HOME/.kinako" >/dev/null 2>&1 & echo $!`,
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
      }).pipe(Effect.provide(NodeServices.layer)),
    30_000,
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
      }).pipe(Effect.provide(NodeServices.layer)),
    30_000,
  );

  it.live.skipIf(windowsHost)(
    "leaves a server it did not start on loopback when network access is enabled",
    () =>
      Effect.gen(function* () {
        const host = yield* makeHost();
        const executable = `${host.home}/.kinako/runtime/versions/${archiveVersion}/kinako`;
        yield* host.run(host.home, [
          "-c",
          `T3CODE_PORT=4300 nohup "${executable}" __service-launcher >/dev/null 2>&1 &`,
        ]);
        yield* host.untilReady(4300);
        yield* host.setNetworkAccess(true);

        assert.deepEqual(yield* host.launch(routeA), {
          remotePort: 4300,
          serverKind: "external",
          networkAccess: false,
        });
        assert.equal((yield* host.servers).length, 1);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live.skipIf(windowsHost)("reuses a server it did not start and never stops it", () =>
    Effect.gen(function* () {
      const host = yield* makeHost();
      const executable = `${host.home}/.kinako/runtime/versions/${archiveVersion}/kinako`;
      yield* host.run(host.home, [
        "-c",
        `T3CODE_PORT=4200 nohup "${executable}" __service-launcher >/dev/null 2>&1 &`,
      ]);
      yield* host.untilReady(4200);

      assert.deepEqual(yield* host.launch(routeA), {
        remotePort: 4200,
        serverKind: "external",
        networkAccess: false,
      });
      yield* host.stop(routeA);
      const servers = yield* host.servers;
      assert.equal(servers.length, 1);
      assert.isTrue(servers[0]?.alive);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live.skipIf(windowsHost)(
    "waits for its busy server instead of replacing it",
    () =>
      Effect.gen(function* () {
        const host = yield* makeHost();
        const first = yield* host.launch(routeA);
        const [server] = yield* host.servers;

        // The server stops answering for longer than a quick reuse probe allows.
        yield* host.fs.remove(`${host.home}/ready/${first.remotePort}`);
        yield* host.run(host.home, [
          "-c",
          `(sleep 3; : >"$HOME/ready/${first.remotePort}") >/dev/null 2>&1 &`,
        ]);
        assert.deepEqual(yield* host.launch(routeA), first);
        const servers = yield* host.servers;
        assert.equal(servers.length, 1);
        assert.equal(servers[0]?.pid, server?.pid);
        assert.isTrue(servers[0]?.alive);
      }).pipe(Effect.provide(NodeServices.layer)),
    30_000,
  );

  it.live.skipIf(windowsHost)(
    "fails without stopping a server that never becomes ready",
    () =>
      Effect.gen(function* () {
        const host = yield* makeHost();
        const first = yield* host.launch(routeA);
        const [server] = yield* host.servers;
        yield* host.fs.remove(`${host.home}/ready/${first.remotePort}`);

        const script = yield* host.fs.readFileString(host.launchScript);
        assert.include(script, 'wait_ready "60000"');
        yield* host.fs.writeFileString(
          host.launchScript,
          script.replaceAll('wait_ready "60000"', 'wait_ready "500"'),
        );
        const result = yield* host.run(host.home, [host.launchScript, routeA]);
        assert.equal(result.exitCode, 1, result.stdout);
        assert.include(result.stderr, "the server was left running");
        const servers = yield* host.servers;
        assert.equal(servers.length, 1);
        assert.isTrue(servers[0]?.alive);
        assert.equal(
          (yield* host.fs.readFileString(`${host.home}/.kinako/ssh-launch/server/pid`)).trim(),
          `${server?.pid}`,
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    30_000,
  );

  it.live.skipIf(windowsHost)(
    "replaces a recorded server that exited but was not reaped",
    () =>
      Effect.gen(function* () {
        const host = yield* makeHost();
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

        // A crashed server whose parent never reaps it stays a zombie, which
        // kill -0 still reports.
        const parent = yield* spawner.spawn(
          ChildProcess.make("sh", ["-c", "sleep 600 & echo $!; exec sleep 600"]),
        );
        const zombie = Number(
          Option.getOrThrow(
            yield* parent.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runHead),
          ),
        );
        process.kill(zombie, "SIGKILL");
        // SIGKILL delivery is asynchronous; establish the zombie fixture before launching.
        const zombieState = yield* host.run(host.home, [
          "-c",
          `attempt=0; while [ "$attempt" -lt 100 ]; do
            state=$(ps -o stat= -p ${zombie}) || exit 1
            case "$state" in *Z*) printf '%s\\n' "$state"; exit 0;; esac
            attempt=$((attempt + 1))
          done; printf '%s\\n' "$state"; exit 1`,
        ]);
        assert.equal(zombieState.exitCode, 0, zombieState.stdout);
        assert.include(zombieState.stdout, "Z");
        const serverDir = `${host.home}/.kinako/ssh-launch/server`;
        yield* host.fs.makeDirectory(serverDir, { recursive: true });
        yield* host.fs.writeFileString(`${serverDir}/pid`, `${zombie}\n`);
        yield* host.fs.writeFileString(`${serverDir}/port`, "4300\n");
        yield* host.fs.writeFileString(`${serverDir}/mode`, "launcher\n");
        yield* host.fs.writeFileString(`${serverDir}/owner`, `${routeA}\n`);

        assert.equal((yield* host.launch(routeA)).serverKind, "managed");
        const servers = yield* host.servers;
        assert.equal(servers.length, 1);
        assert.isTrue(servers[0]?.alive);
      }).pipe(Effect.provide(NodeServices.layer)),
    30_000,
  );
});
