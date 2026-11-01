import type { DesktopBridge, DesktopCloudflareState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

class DesktopCloudflareUnavailableError extends Schema.TaggedError<DesktopCloudflareUnavailableError>()(
  "DesktopCloudflareUnavailableError",
  { cause: Schema.optionalKey(Schema.Defect()) },
) {
  override get message(): string {
    return "Cloudflare public routes are set up from the desktop app.";
  }
}

export function desktopCloudflareBridge(): DesktopBridge["cloudflare"] | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge?.cloudflare;
}

export const desktopCloudflareStateAtom = Atom.make(
  Effect.gen(function* () {
    const bridge = desktopCloudflareBridge();
    if (!bridge) return yield* new DesktopCloudflareUnavailableError({});
    return yield* Effect.tryPromise({
      try: (): Promise<DesktopCloudflareState> => bridge.getState(),
      catch: (cause) => new DesktopCloudflareUnavailableError({ cause }),
    });
  }),
).pipe(Atom.keepAlive, Atom.withLabel("desktop:cloudflare"));

export function refreshDesktopCloudflareState(): void {
  appAtomRegistry.refresh(desktopCloudflareStateAtom);
}

/** Electron prefixes rejected IPC calls with the channel; users need only the reason. */
export function desktopCloudflareErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (?:\w+Error: )?/u, "");
}
