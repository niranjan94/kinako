import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Schema from "effect/Schema";

/** What a sandboxed full access thread's provider needs to build its OS sandbox at spawn. */
export const SandboxRequest = Schema.Struct({
  settings: Schema.Struct({
    readWritePaths: Schema.Array(Schema.String),
    readOnlyPaths: Schema.Array(Schema.String),
    allowDocker: Schema.Boolean,
    allowSshAgent: Schema.Boolean,
  }),
  baseDir: Schema.String,
  worktreesDir: Schema.String,
  attachmentsDir: Schema.String,
  serverPaths: Schema.Array(Schema.String),
  /**
   * Each checkout the thread works in, with the repository the server created it from. A linked
   * worktree needs its repository's git dir, which is granted from this, never from the checkout.
   */
  gitCheckouts: Schema.Array(Schema.Struct({ checkout: Schema.String, repository: Schema.String })),
});
export type SandboxRequest = typeof SandboxRequest.Type;

const ExternalSandboxPolicy = Schema.Struct({
  type: Schema.Literal("externalSandbox"),
  request: SandboxRequest,
});
const isExternalSandboxPolicy = Schema.is(ExternalSandboxPolicy);

export const externalSandboxPolicy = (request: SandboxRequest) =>
  ({ type: "externalSandbox", request }) satisfies typeof ExternalSandboxPolicy.Type;

/**
 * The sandbox a thread's provider must run in, or undefined. A provider may skip approvals for
 * sandboxed full access only when this is defined and it wraps its process with it.
 */
export function externalSandboxRequest(
  policy: Pick<ProviderAdapter.ProviderAdapterV2RuntimePolicy, "runtimeMode" | "sandboxPolicy">,
): SandboxRequest | undefined {
  return policy.runtimeMode === "sandboxed-full-access" &&
    isExternalSandboxPolicy(policy.sandboxPolicy)
    ? policy.sandboxPolicy.request
    : undefined;
}
