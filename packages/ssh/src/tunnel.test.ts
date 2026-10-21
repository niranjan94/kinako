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
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as SshAuth from "./auth.ts";
import { SshCommandError } from "./errors.ts";
import * as SshTunnel from "./tunnel.ts";

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
  hasListenerOnHost: () => Effect.succeed(false),
  reserveLoopbackPort: () => Effect.succeed(41_773),
  findAvailablePort: (preferred) => Effect.succeed(preferred),
});

function commandArgs(command: ChildProcess.Command): ReadonlyArray<string> {
  return command._tag === "StandardCommand" ? command.args : [];
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
        Layer.merge(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      ),
    );
    const script = scripts.at(-1);
    assert.isDefined(script);
    return script;
  });

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
      }).pipe(Effect.provide(NodeServices.layer)),
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
      }).pipe(Effect.provide(NodeServices.layer)),
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
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
