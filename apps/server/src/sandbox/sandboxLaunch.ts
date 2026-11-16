import type { SandboxPlatform } from "@t3tools/contracts";
import { desktopAppControlDirectories } from "@t3tools/shared/desktopAppControl";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Hash from "effect/Hash";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type { SandboxRequest } from "./externalSandbox.ts";
import {
  type ResolveSandboxPolicyInput,
  resolveSandboxPolicy,
  SandboxPolicyRefusedError,
} from "./resolveSandboxPolicy.ts";
import * as Sandbox from "./Sandbox.ts";

const SCRIPT_EXTENSIONS = [".js", ".mjs", ".cjs", ".tsx", ".ts", ".jsx"];

/** The private tmux and screen socket dir for sandboxed sessions whose real cwd is `cwd`. */
export const multiplexerDirFor = (uid: number, cwd: string) =>
  `/tmp/kinako-mux-${uid}-${(Hash.string(cwd) >>> 0).toString(16)}`;

/**
 * The command that starts a provider's executable inside a thread's sandbox. Fails, so the
 * session fails, whenever the sandbox cannot be built or applied.
 */
export const sandboxProviderLaunch = Effect.fn("SandboxLaunch.provider")(function* (input: {
  readonly providerName: string;
  readonly request: SandboxRequest;
  readonly cwd: string;
  readonly additionalDirectories: ReadonlyArray<string>;
  readonly executable: string;
  readonly args?: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly providerPaths: (context: {
    readonly platform: SandboxPlatform;
    readonly home: string;
    /** The real path of the executable that will run. */
    readonly executable: string;
  }) => Effect.Effect<
    ResolveSandboxPolicyInput["providerPaths"],
    never,
    FileSystem.FileSystem | Path.Path
  >;
}) {
  const platform = yield* HostProcess.Platform;
  if (platform !== "linux" && platform !== "darwin") {
    return yield* new SandboxPolicyRefusedError({
      reason: "The filesystem sandbox only runs on Linux and macOS.",
    });
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const uid = (yield* HostProcess.UserId) ?? -1;
  const resolved = yield* resolveCommandPath(input.executable, { env: input.env }).pipe(
    Effect.orElseSucceed(() => null),
  );
  const executable =
    resolved === null
      ? undefined
      : yield* fileSystem.realPath(resolved).pipe(Effect.orElseSucceed(() => undefined));
  if (executable === undefined) {
    return yield* new SandboxPolicyRefusedError({
      reason: `${input.providerName}'s executable ${input.executable} was not found.`,
    });
  }
  if (SCRIPT_EXTENSIONS.some((extension) => executable.endsWith(extension))) {
    return yield* new SandboxPolicyRefusedError({
      reason: `${input.providerName}'s executable ${executable} is a script; the sandbox needs the native executable.`,
    });
  }
  // bwrap cannot hide a path that does not exist yet, so the desktop app's control socket dir
  // is made now, as the app makes it, for the policy to hide. Never recursive: TMPDIR may be bogus.
  for (const directory of desktopAppControlDirectories({
    tempDirs: input.env.TMPDIR === undefined ? [] : [input.env.TMPDIR],
    userId: uid,
    joinPath: path.join,
  })) {
    yield* fileSystem.makeDirectory(directory, { mode: 0o700 }).pipe(Effect.ignore);
  }
  const policy = yield* resolveSandboxPolicy({
    platform,
    home,
    uid,
    cwd: input.cwd,
    additionalDirectories: input.additionalDirectories.map((directory) => ({
      path: path.resolve(input.cwd, directory),
      access: "read-write",
    })),
    providerPaths: yield* input.providerPaths({ platform, home, executable }),
    ...input.request,
    pathEnv: input.env.PATH,
    tmpDir: input.env.TMPDIR,
    sshAuthSock: input.env.SSH_AUTH_SOCK,
    userName: (yield* HostProcess.Username) ?? undefined,
    tmuxTmpDir: input.env.TMUX_TMPDIR,
    screenDir: input.env.SCREENDIR,
  });
  // The user's tmux and screen sockets are hidden, so the agent's own run from a private dir.
  const multiplexerDir = multiplexerDirFor(uid, policy.cwd);
  yield* fileSystem.makeDirectory(path.join(multiplexerDir, "screen"), { recursive: true }).pipe(
    Effect.andThen(fileSystem.chmod(multiplexerDir, 0o700)),
    Effect.andThen(fileSystem.chmod(path.join(multiplexerDir, "screen"), 0o700)),
    Effect.mapError(
      (cause) =>
        new SandboxPolicyRefusedError({
          reason: `Could not create the private terminal multiplexer dir ${multiplexerDir}.`,
          cause,
        }),
    ),
  );
  const sandbox = yield* Sandbox.Sandbox;
  return yield* sandbox.wrap({
    command: executable,
    args: input.args ?? [],
    env: {
      ...input.env,
      TMUX_TMPDIR: multiplexerDir,
      SCREENDIR: path.join(multiplexerDir, "screen"),
    },
    policy,
  });
});
