import {
  managedRuntimeModeDenial,
  type ManagedPolicySummary,
  providerSupportsRuntimeMode,
  type RuntimeMode,
} from "@t3tools/contracts";
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
    description: "Allow commands and edits without prompts, confined to a filesystem sandbox.",
    icon: BoxIcon,
  },
  "full-access": {
    label: "Full access",
    description: "Allow commands and edits without prompts.",
    // An open lock reads like a closed one at small sizes; a crossed shield does not.
    icon: ShieldOffIcon,
  },
};

// Sandboxed full access stays out of pickers until providers run inside the sandbox.
export const runtimeModeOptions: ReadonlyArray<RuntimeMode> = (
  Object.keys(runtimeModeConfig) as RuntimeMode[]
).filter((mode) => mode !== "sandboxed-full-access");

/** The modes a provider supports and the mode a thread really runs in. */
export function resolveCompatibleRuntimeMode(
  runtimeMode: RuntimeMode,
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
) {
  const modes = runtimeModeOptions.filter((mode) =>
    providerSupportsRuntimeMode(supportedRuntimeModes, mode),
  );
  return { modes, mode: modes.includes(runtimeMode) ? runtimeMode : (modes[0] ?? runtimeMode) };
}

export function resolveRuntimeModeOptions(
  modes: ReadonlyArray<RuntimeMode>,
  managedPolicy: ManagedPolicySummary | undefined,
) {
  return modes.map((mode) => {
    const option = { mode, ...runtimeModeConfig[mode] };
    const disabledReason = managedRuntimeModeDenial(managedPolicy, mode);
    return disabledReason === undefined ? option : { ...option, disabledReason };
  });
}
