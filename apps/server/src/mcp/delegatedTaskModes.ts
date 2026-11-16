import {
  isRuntimeModeWithinCallerLimit,
  type ModelSelection,
  OrchestratorMcpFailure,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpInteractionMode,
  type OrchestratorMcpRuntimeMode,
  type ProviderInteractionMode,
  providerSupportsRuntimeMode,
  RuntimeMode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

/** How much an interaction mode allows: plan, then default. */
export function interactionModeRank(mode: ProviderInteractionMode): number {
  return mode === "plan" ? 0 : 1;
}

/**
 * The mode a child runs at: the one asked for, within its parent's limit.
 * An inherited mode the target provider does not offer steps down to the
 * broadest one it does within that limit; an explicitly requested one is
 * refused instead.
 */
export function resolveRuntimeMode(
  parentMode: RuntimeMode,
  requested: OrchestratorMcpRuntimeMode | undefined,
  target?: {
    readonly modelSelection: ModelSelection;
    readonly supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined;
  },
): Effect.Effect<RuntimeMode, OrchestratorMcpFailure> {
  const inherited = requested === undefined || requested === "inherit";
  const resolved = inherited ? parentMode : requested;
  if (!isRuntimeModeWithinCallerLimit(resolved, parentMode)) {
    return Effect.fail(
      new OrchestratorMcpFailure({
        code: "runtime_mode_escalation_denied",
        message:
          parentMode === "sandboxed-full-access"
            ? `Child runtime mode ${resolved} runs outside the sandbox without approval, which parent mode ${parentMode} does not allow. Use sandboxed-full-access or approval-required.`
            : `Child runtime mode ${resolved} is broader than parent mode ${parentMode}.`,
      }),
    );
  }
  if (target === undefined || providerSupportsRuntimeMode(target.supportedRuntimeModes, resolved)) {
    return Effect.succeed(resolved);
  }
  const offered = RuntimeMode.literals.filter((mode) =>
    providerSupportsRuntimeMode(target.supportedRuntimeModes, mode),
  );
  if (!inherited) {
    return Effect.fail(
      new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `Provider ${target.modelSelection.instanceId} does not offer runtime mode ${resolved}, so it would run as approval-required. Use one of: ${offered.join(", ")}.`,
      }),
    );
  }
  // RuntimeMode's literals run narrowest first, so the last one within the limit is the broadest.
  return Effect.succeed(
    offered.findLast((mode) => isRuntimeModeWithinCallerLimit(mode, resolved)) ??
      "approval-required",
  );
}

/** The same, for interaction modes. */
export function resolveInteractionMode(
  parentMode: ProviderInteractionMode,
  requested: OrchestratorMcpInteractionMode | undefined,
): Effect.Effect<ProviderInteractionMode, OrchestratorMcpFailure> {
  const resolved = requested === undefined || requested === "inherit" ? parentMode : requested;
  return interactionModeRank(resolved) > interactionModeRank(parentMode)
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "interaction_mode_escalation_denied",
          message: `Child interaction mode ${resolved} is broader than parent mode ${parentMode}.`,
        }),
      )
    : Effect.succeed(resolved);
}

/** The task as its child receives it, with the role the caller asked for. */
export function taskPrompt(input: OrchestratorMcpDelegateTaskInput): string {
  return input.role === undefined || input.role === "general"
    ? input.task
    : `Act as the ${input.role} sub-agent for this task.\n\n${input.task}`;
}
