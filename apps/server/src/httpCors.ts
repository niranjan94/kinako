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

export const DESKTOP_RENDERER_ORIGINS = [
  `${FORK_URL_SCHEME}://app`,
  `${FORK_DEV_URL_SCHEME}://app`,
] as const;

/** MCP refuses every browser Origin with 403, so the browser CORS layer must not answer for it. */
export const MCP_HTTP_PATH = "/mcp";
