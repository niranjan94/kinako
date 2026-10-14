import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as HostProcess from "./HostProcess.ts";

const MDNS_HOST_NAME_READ_TIMEOUT = Duration.seconds(2);
const MDNS_HOST_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/** `<first-label>.local` for a hostname, or null when the label is not a valid DNS label. */
export function toMdnsHostName(rawName: string): string | null {
  const label = rawName.trim().split(".")[0]?.toLowerCase() ?? "";
  return MDNS_HOST_LABEL_PATTERN.test(label) ? `${label}.local` : null;
}

/** The `<name>.local` hostname this machine answers to over mDNS, or null when unknown. */
export const readMdnsHostName = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  if (platform !== "darwin") {
    return toMdnsHostName(yield* HostProcess.Hostname);
  }

  // macOS renames its Bonjour host on a conflict (`tardis` to `tardis-2`) while the OS
  // hostname stays put, so only LocalHostName names what actually resolves.
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const localHostName = yield* spawner
    .string(
      ChildProcess.make("/usr/sbin/scutil", ["--get", "LocalHostName"], {
        stdin: "ignore",
        stderr: "ignore",
      }),
    )
    .pipe(
      Effect.timeout(MDNS_HOST_NAME_READ_TIMEOUT),
      Effect.orElseSucceed(() => ""),
    );
  return toMdnsHostName(localHostName);
}).pipe(Effect.catchDefect(() => Effect.succeed(null)));
