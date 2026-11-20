import {
  acpPermissionDisposition,
  type AcpPermissionDisposition,
  type AcpRuntimePolicy,
} from "@t3tools/provider-acp/server/clientPolicy";
import type * as EffectAcpSchema from "effect-acp/compat";

/**
 * Registry agents share no reviewer the app can rely on, so Auto asks wherever Supervised
 * would; otherwise what reaches the app under Auto would run as Full access.
 */
export function acpRegistryPermissionDisposition(
  policy: AcpRuntimePolicy,
  request: EffectAcpSchema.RequestPermissionRequest,
): AcpPermissionDisposition {
  return acpPermissionDisposition(
    policy.runtimeMode === "auto" ? { ...policy, runtimeMode: "approval-required" } : policy,
    request,
  );
}
