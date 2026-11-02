import * as Schema from "effect/Schema";

import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * `kn-` plus 26 base32 characters. The desktop puts it one label under the zone, since
 * Universal SSL covers only `*.<zone>` and a deeper name would fail its TLS handshake.
 */
const PUBLIC_ROUTE_HOSTNAME_PATTERN =
  /^kn-[a-z2-7]{26}\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9-]{2,63}$/u;

export const PublicRouteHostname = TrimmedNonEmptyString.check(
  Schema.isPattern(PUBLIC_ROUTE_HOSTNAME_PATTERN),
);
export type PublicRouteHostname = typeof PublicRouteHostname.Type;

export const PublicRouteEnableInput = Schema.Struct({
  hostname: PublicRouteHostname,
  tunnelId: TrimmedNonEmptyString,
  /** Runs this one tunnel only; the Cloudflare account token never leaves the desktop. */
  connectorToken: Schema.RedactedFromValue(TrimmedNonEmptyString),
});
export type PublicRouteEnableInput = typeof PublicRouteEnableInput.Type;

export const PublicRouteState = Schema.Literals([
  "off",
  "connecting",
  "live",
  /** Cloudflare refused the connector, usually because the tunnel was deleted; the host dropped it. */
  "rejected",
  "cloudflared-missing",
  "failed",
]);
export type PublicRouteState = typeof PublicRouteState.Type;

export const PublicRouteStatus = Schema.Struct({
  state: PublicRouteState,
  hostname: Schema.NullOr(TrimmedNonEmptyString),
  tunnelId: Schema.NullOr(TrimmedNonEmptyString),
  /** The loopback port the tunnel's ingress must point at. */
  originPort: PositiveInt,
  detail: Schema.NullOr(Schema.String),
});
export type PublicRouteStatus = typeof PublicRouteStatus.Type;

export class PublicRouteError extends Schema.TaggedError<PublicRouteError>()("PublicRouteError", {
  reason: Schema.Literals(["storage", "managed_by_policy"]),
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}
