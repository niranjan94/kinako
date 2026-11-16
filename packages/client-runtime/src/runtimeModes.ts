import {
  providerSupportsRuntimeMode,
  type RuntimeMode,
  type SandboxStatus,
} from "@t3tools/contracts";

export const SANDBOXED_FULL_ACCESS_DESCRIPTION =
  "No approval prompts. File access is limited to the project, temp folders and paths you allow; network is unrestricted.";

/**
 * Whether a picker for a provider lists `mode`. A thread stored in sandboxed full access keeps
 * that option even when its provider cannot run it, so it is not labelled as another mode.
 */
export function isRuntimeModeOffered(
  mode: RuntimeMode,
  storedMode: RuntimeMode,
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
): boolean {
  return (
    providerSupportsRuntimeMode(supportedRuntimeModes, mode) ||
    (mode === "sandboxed-full-access" && storedMode === mode)
  );
}

/** Why the environment cannot run sandboxed full access, or undefined when it can or did not say. */
export function sandboxUnavailableReason(status: SandboxStatus | undefined): string | undefined {
  if (status === undefined || status.available) return undefined;
  return `The sandbox is unavailable on this environment: ${status.reason ?? "no reason given."}`;
}

/** Why `mode` cannot be picked for this provider and environment, or undefined. */
export function sandboxedRuntimeModeDenial(
  mode: RuntimeMode,
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
  status: SandboxStatus | undefined,
): string | undefined {
  if (mode !== "sandboxed-full-access") return undefined;
  if (!providerSupportsRuntimeMode(supportedRuntimeModes, mode)) {
    return "This provider cannot run sandboxed full access, so the thread runs as Supervised.";
  }
  return sandboxUnavailableReason(status);
}
