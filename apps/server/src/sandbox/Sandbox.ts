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

const UNSUPPORTED_REASON = "The filesystem sandbox only runs on Linux and macOS.";

/** The OS sandbox for this host: bubblewrap on Linux, Seatbelt on macOS, none elsewhere. */
export class Sandbox extends Context.Service<
  Sandbox,
  {
    readonly availability: Effect.Effect<SandboxAvailability>;
    /** The command that runs `input` inside `policy`. Fails rather than run it unsandboxed. */
    readonly wrap: (
      input: SandboxedCommand & { readonly policy: SandboxPolicy },
    ) => Effect.Effect<SandboxedCommand, SandboxUnavailableError>;
  }
>()("t3/sandbox/Sandbox") {}

const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  if (platform === "linux") return Sandbox.of(yield* Bubblewrap.Bubblewrap);
  if (platform === "darwin") return Sandbox.of(yield* Seatbelt.Seatbelt);
  return Sandbox.of({
    availability: Effect.succeed({ _tag: "Unavailable", reason: UNSUPPORTED_REASON }),
    wrap: Effect.fn("Sandbox.wrap")(function* () {
      return yield* new SandboxUnavailableError({ reason: UNSUPPORTED_REASON });
    }),
  });
});

export const layer = Layer.effect(Sandbox, make).pipe(
  Layer.provide(Layer.mergeAll(Bubblewrap.layer, Seatbelt.layer)),
);
