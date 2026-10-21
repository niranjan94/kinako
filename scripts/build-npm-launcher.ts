#!/usr/bin/env node
/**
 * Builds the `kinako-cli` npm package behind `npx kinako-cli` / `npm i -g kinako-cli`: a launcher
 * with no dependencies that downloads this exact version's CLI archive from
 * the GitHub Release on first run (scripts/npm-launcher/t3.mjs).
 * The executables are not published to npm. npm's publish-time scanning held
 * 250 MB platform packages back for up to an hour after the launcher went
 * live, and every install in that window ran a launcher with nothing to
 * launch.
 *
 * Output: `<output-dir>/kinako-cli/` (the package tree) and `<output-dir>/kinako-cli.tgz`,
 * which is what gets published.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  FORK_CLI_NAME,
  FORK_DISPLAY_NAME,
  FORK_HOME_DIR_NAME,
  FORK_NPM_PACKAGE_NAME,
  FORK_REPOSITORY,
} from "@t3tools/shared/forkBrand";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import serverPackageJson from "../apps/server/package.json" with { type: "json" };

import { windowsSystemTar } from "./lib/windows-tar.ts";

export const NPM_LAUNCHER_PACKAGE_NAME = FORK_NPM_PACKAGE_NAME;

/**
 * Upstream's launcher source, rebranded at build time so the file itself
 * stays identical to upstream's and merges cleanly. Every literal must still
 * be present: a miss means upstream changed the launcher and this list needs
 * updating, which the build reports instead of shipping a launcher that
 * downloads upstream's release.
 */
const LAUNCHER_REBRAND: ReadonlyArray<readonly [string, string]> = [
  ['path.join(os.homedir(), ".t3")', `path.join(os.homedir(), "${FORK_HOME_DIR_NAME}")`],
  ["`t3-${version}-${key}.", `\`${FORK_CLI_NAME}-\${version}-\${key}.`],
  [
    "https://github.com/pingdotgg/t3code/releases",
    `https://github.com/${FORK_REPOSITORY}/releases`,
  ],
  ['"t3.exe" : "t3"', `"${FORK_CLI_NAME}.exe" : "${FORK_CLI_NAME}"`],
  ["t3: ", `${FORK_CLI_NAME}: `],
  ["T3 Code", FORK_DISPLAY_NAME],
];

export class NpmLauncherRebrandError extends Schema.TaggedError<NpmLauncherRebrandError>()(
  "NpmLauncherRebrandError",
  { literal: Schema.String },
) {
  override get message(): string {
    return `scripts/npm-launcher/t3.mjs no longer contains ${JSON.stringify(this.literal)}; update LAUNCHER_REBRAND in scripts/build-npm-launcher.ts.`;
  }
}

export const rebrandLauncher = Effect.fn("rebrandLauncher")(function* (source: string) {
  let output = source;
  for (const [from, to] of LAUNCHER_REBRAND) {
    if (!output.includes(from)) return yield* new NpmLauncherRebrandError({ literal: from });
    output = output.replaceAll(from, to);
  }
  return output;
});

const encodePackageJson = Schema.encodeEffect(fromJsonStringPretty(Schema.Unknown));

export class NpmLauncherCommandFailedError extends Schema.TaggedError<NpmLauncherCommandFailedError>()(
  "NpmLauncherCommandFailedError",
  { command: Schema.String, exitCode: Schema.Int },
) {
  override get message(): string {
    return `${this.command} exited with code ${this.exitCode}.`;
  }
}

/** package.json for the launcher. `engines` asks for `import.meta.dirname` and `fetch`. */
export function npmLauncherPackageManifest(version: string) {
  return {
    name: NPM_LAUNCHER_PACKAGE_NAME,
    version,
    description: `${FORK_DISPLAY_NAME} CLI. Downloads the self-contained executable for this platform from the GitHub Release.`,
    license: serverPackageJson.license,
    // npm provenance rejects a publish whose repository is not the one that built it.
    repository: { type: "git", url: `https://github.com/${FORK_REPOSITORY}` },
    bin: { [FORK_CLI_NAME]: `./bin/${FORK_CLI_NAME}.mjs` },
    files: ["bin", "dist"],
    engines: { node: ">=20.11" },
  };
}

export const buildNpmLauncher = Effect.fn("buildNpmLauncher")(function* (input: {
  readonly version: string;
  readonly outputDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const sourceDir = yield* path.fromFileUrl(new URL("./npm-launcher/", import.meta.url));

  yield* fs.makeDirectory(input.outputDir, { recursive: true });
  const scratch = yield* fs.makeTempDirectoryScoped({
    directory: input.outputDir,
    prefix: ".launcher-",
  });
  const stageDir = path.join(scratch, "package");
  yield* fs.makeDirectory(path.join(stageDir, "bin"), { recursive: true });
  yield* fs.makeDirectory(path.join(stageDir, "dist"));
  yield* fs.writeFileString(
    path.join(stageDir, "package.json"),
    `${yield* encodePackageJson(npmLauncherPackageManifest(input.version))}\n`,
  );
  yield* fs.writeFileString(
    path.join(stageDir, `bin/${FORK_CLI_NAME}.mjs`),
    yield* rebrandLauncher(yield* fs.readFileString(path.join(sourceDir, "t3.mjs"))),
  );
  yield* fs.chmod(path.join(stageDir, `bin/${FORK_CLI_NAME}.mjs`), 0o755);
  yield* fs.writeFileString(
    path.join(stageDir, "dist/bin.mjs"),
    (yield* fs.readFileString(path.join(sourceDir, "bin.mjs"))).replace(
      "../bin/t3.mjs",
      `../bin/${FORK_CLI_NAME}.mjs`,
    ),
  );
  const readme = yield* path.fromFileUrl(new URL("../README.md", import.meta.url));
  if (yield* fs.exists(readme)) {
    yield* fs.copyFile(readme, path.join(stageDir, "README.md"));
  }

  const packageDir = path.join(input.outputDir, NPM_LAUNCHER_PACKAGE_NAME);
  const tarball = path.join(input.outputDir, `${NPM_LAUNCHER_PACKAGE_NAME}.tgz`);
  yield* fs.remove(tarball, { force: true });
  const tar = (yield* HostProcess.Platform) === "win32" ? windowsSystemTar() : "tar";
  // npm tarballs root everything under `package/`.
  const child = yield* spawner.spawn(
    ChildProcess.make(tar, ["-czf", tarball, "-C", scratch, "package"], {
      stdout: "inherit",
      stderr: "inherit",
    }),
  );
  const exitCode = Number(yield* child.exitCode);
  if (exitCode !== 0) {
    return yield* new NpmLauncherCommandFailedError({ command: `tar (${tarball})`, exitCode });
  }
  yield* fs.remove(packageDir, { recursive: true, force: true });
  yield* fs.rename(stageDir, packageDir);
  yield* Effect.log(`[npm-launcher] Wrote ${packageDir} and ${tarball}`);
  return { packageDir, tarball };
}, Effect.scoped);

const command = Command.make(
  "build-npm-launcher",
  {
    version: Flag.String("version").pipe(
      Flag.withDescription("Exact release version; the launcher downloads this version's archive."),
    ),
    outputDir: Flag.String("output-dir").pipe(Flag.withDefault("npm-packages")),
  },
  buildNpmLauncher,
).pipe(Command.withDescription(`Build the ${NPM_LAUNCHER_PACKAGE_NAME} npm launcher package.`));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer)),
    NodeRuntime.runMain,
  );
}
