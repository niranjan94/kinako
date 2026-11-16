import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Bubblewrap from "./Bubblewrap.ts";
import * as Seatbelt from "./Seatbelt.ts";
import {
  type SandboxAvailability,
  type SandboxedCommand,
  type SandboxPolicy,
  SandboxUnavailableError,
} from "./sandboxPolicy.ts";

export interface SandboxShape {
  readonly availability: Effect.Effect<SandboxAvailability>;
  /**
   * The command that runs `input` inside `policy`. Fails rather than run it unsandboxed.
   * Stop it by signalling its process group; on Linux SIGTERM to its pid alone is ignored.
   */
  readonly wrap: (
    input: SandboxedCommand & { readonly policy: SandboxPolicy },
  ) => Effect.Effect<SandboxedCommand, SandboxUnavailableError>;
}

const refusing = (reason: string): SandboxShape => ({
  availability: Effect.succeed({ _tag: "Unavailable", reason }),
  wrap: Effect.fn("Sandbox.wrap")(function* () {
    return yield* new SandboxUnavailableError({ reason });
  }),
});

/** The OS sandbox for this host: bubblewrap on Linux, Seatbelt on macOS, none elsewhere. */
export const Sandbox = Context.Reference<SandboxShape>("t3/sandbox/Sandbox", {
  defaultValue: () => refusing("The filesystem sandbox is not set up in this server."),
});

const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  if (platform === "linux") return yield* Bubblewrap.Bubblewrap;
  if (platform === "darwin") return yield* Seatbelt.Seatbelt;
  return refusing("The filesystem sandbox only runs on Linux and macOS.");
});

export const layer = Layer.effect(Sandbox, make).pipe(
  Layer.provide(Layer.mergeAll(Bubblewrap.layer, Seatbelt.layer)),
);
