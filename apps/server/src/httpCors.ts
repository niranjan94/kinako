import { ORCHESTRATION_PROTOCOL_HEADER } from "@t3tools/contracts";
import { FORK_DEV_URL_SCHEME, FORK_URL_SCHEME } from "@t3tools/shared/forkBrand";

export const browserApiCorsAllowedMethods = ["GET", "POST", "OPTIONS"] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
  "dpop",
  ORCHESTRATION_PROTOCOL_HEADER,
] as const;

/** Origins of the Electron renderer, packaged and dev. */
export const DESKTOP_RENDERER_ORIGINS = [
  `${FORK_URL_SCHEME}://app`,
  `${FORK_DEV_URL_SCHEME}://app`,
] as const;
