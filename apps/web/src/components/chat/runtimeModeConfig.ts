import {
  managedRuntimeModeDenial,
  type ManagedPolicySummary,
  type RuntimeMode,
  type SandboxStatus,
} from "@t3tools/contracts";
import {
  isRuntimeModeOffered,
  SANDBOXED_FULL_ACCESS_DESCRIPTION,
  sandboxedRuntimeModeDenial,
} from "@t3tools/client-runtime/runtime-modes";
import {
  BoxIcon,
  type LucideIcon,
  LockIcon,
  PenLineIcon,
  ShieldCheckIcon,
  ShieldOffIcon,
} from "lucide-react";

export const runtimeModeConfig: Record<
  RuntimeMode,
  { label: string; description: string; icon: LucideIcon }
> = {
  "approval-required": {
    label: "Supervised",
    description: "Ask before commands and file changes.",
    icon: LockIcon,
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
    icon: PenLineIcon,
  },
  auto: {
    label: "Auto",
    description: "Supported providers approve routine actions; others still ask.",
    icon: ShieldCheckIcon,
  },
  "sandboxed-full-access": {
    label: "Sandboxed full access",
    description: SANDBOXED_FULL_ACCESS_DESCRIPTION,
    icon: BoxIcon,
  },
  "full-access": {
    label: "Full access",
    description: "Allow commands and edits without prompts.",
    // An open lock reads like a closed one at small sizes; a crossed shield does not.
    icon: ShieldOffIcon,
  },
};

export const runtimeModeOptions = Object.keys(runtimeModeConfig) as RuntimeMode[];

/** The modes a provider supports and the mode a thread really runs in. */
export function resolveCompatibleRuntimeMode(
  runtimeMode: RuntimeMode,
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
) {
  const modes = runtimeModeOptions.filter((mode) =>
    isRuntimeModeOffered(mode, runtimeMode, supportedRuntimeModes),
  );
  return { modes, mode: modes.includes(runtimeMode) ? runtimeMode : (modes[0] ?? runtimeMode) };
}

export function resolveRuntimeModeOptions(
  modes: ReadonlyArray<RuntimeMode>,
  managedPolicy: ManagedPolicySummary | undefined,
  environment: {
    readonly supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined;
    readonly sandbox: SandboxStatus | undefined;
  },
) {
  return modes.map((mode) => {
    const option = { mode, ...runtimeModeConfig[mode] };
    const disabledReason =
      managedRuntimeModeDenial(managedPolicy, mode) ??
      sandboxedRuntimeModeDenial(mode, environment.supportedRuntimeModes, environment.sandbox);
    return disabledReason === undefined ? option : { ...option, disabledReason };
  });
}
