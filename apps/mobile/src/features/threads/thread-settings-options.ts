import {
  managedRuntimeModeDenial,
  type ManagedPolicySummary,
  type RuntimeMode,
} from "@t3tools/contracts";
import {
  isRuntimeModeOffered,
  SANDBOXED_FULL_ACCESS_DESCRIPTION,
} from "@t3tools/client-runtime/runtime-modes";

export const RUNTIME_MODE_CHOICES: ReadonlyArray<{
  readonly mode: RuntimeMode;
  readonly label: string;
  readonly description: string;
}> = [
  {
    mode: "approval-required",
    label: "Supervised",
    description: "Ask before commands and file changes.",
  },
  {
    mode: "auto-accept-edits",
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
  },
  {
    mode: "auto",
    label: "Auto",
    description: "Supported providers approve routine actions; others still ask.",
  },
  {
    mode: "sandboxed-full-access",
    label: "Sandboxed full access",
    description: SANDBOXED_FULL_ACCESS_DESCRIPTION,
  },
  {
    mode: "full-access",
    label: "Full access",
    description: "Allow commands and edits without prompts.",
  },
];

/** The modes offered for a provider; a thread's own sandboxed full access always stays listed. */
export function runtimeModeChoicesForSupportedModes(
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
  runtimeMode: RuntimeMode,
) {
  return RUNTIME_MODE_CHOICES.filter((choice) =>
    isRuntimeModeOffered(choice.mode, runtimeMode, supportedRuntimeModes),
  );
}

export type RuntimeModeChoice = (typeof RUNTIME_MODE_CHOICES)[number] & {
  /** Set when a target environment's managed policy caps runtime modes below this one. */
  readonly disabledReason?: string;
};

/**
 * Marks modes above a managed runtime ceiling. A control acting on several environments is
 * managed when any of them is, so the first target that refuses a mode supplies its reason.
 */
export function withManagedRuntimeModeLimits(
  choices: ReadonlyArray<RuntimeModeChoice>,
  policies: ReadonlyArray<ManagedPolicySummary | undefined>,
): ReadonlyArray<RuntimeModeChoice> {
  return choices.map((choice) => {
    const reason = policies
      .map((policy) => managedRuntimeModeDenial(policy, choice.mode))
      .find((denial) => denial !== undefined);
    return reason === undefined ? choice : { ...choice, disabledReason: reason };
  });
}

/** Disables the choices `deny` refuses with its reason, keeping any reason already given. */
export function withRuntimeModeDenials(
  choices: ReadonlyArray<RuntimeModeChoice>,
  deny: (mode: RuntimeMode) => string | undefined,
): ReadonlyArray<RuntimeModeChoice> {
  return choices.map((choice) => {
    if (choice.disabledReason !== undefined) return choice;
    const reason = deny(choice.mode);
    return reason === undefined ? choice : { ...choice, disabledReason: reason };
  });
}

/**
 * A new thread's mode: the draft's choice unless the managed ceiling refuses it, then the
 * default, which the server already reads back at or below the ceiling.
 */
export function resolveNewThreadRuntimeMode(
  draftMode: RuntimeMode | undefined,
  defaultMode: RuntimeMode,
  policy: ManagedPolicySummary | undefined,
): RuntimeMode {
  return draftMode !== undefined && managedRuntimeModeDenial(policy, draftMode) === undefined
    ? draftMode
    : defaultMode;
}

export function compatibleRuntimeModeForChoices(
  runtimeMode: RuntimeMode,
  choices: ReadonlyArray<{ readonly mode: RuntimeMode }>,
): RuntimeMode {
  return choices.some((choice) => choice.mode === runtimeMode)
    ? runtimeMode
    : (choices[0]?.mode ?? runtimeMode);
}

export { selectableProviderOptionChoices as selectableChoices } from "@t3tools/client-runtime/model-traits";
