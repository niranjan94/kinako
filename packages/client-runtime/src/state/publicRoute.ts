import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createPublicRouteEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    status: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:public-route:status",
      tag: WS_METHODS.publicRouteSubscribeStatus,
      idleTtlMs: 0,
    }),
    enable: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:public-route:enable",
      tag: WS_METHODS.publicRouteEnable,
      concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
    }),
    disable: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:public-route:disable",
      tag: WS_METHODS.publicRouteDisable,
      concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
    }),
  };
}
