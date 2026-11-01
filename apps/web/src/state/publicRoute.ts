import { createPublicRouteEnvironmentAtoms } from "@t3tools/client-runtime/state/publicRoute";

import { connectionAtomRuntime } from "../connection/runtime";

export const publicRouteEnvironment = createPublicRouteEnvironmentAtoms(connectionAtomRuntime);
