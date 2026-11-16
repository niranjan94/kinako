import type { EnvironmentId, SandboxStatus } from "@t3tools/contracts";

import { useServerConfigs } from "./entities";

/** Whether the environment's server can run sandboxed full access; undefined when it did not say. */
export function useSandboxStatus(
  environmentId: EnvironmentId | null | undefined,
): SandboxStatus | undefined {
  const serverConfigs = useServerConfigs();
  return environmentId == null ? undefined : serverConfigs.get(environmentId)?.sandbox;
}
