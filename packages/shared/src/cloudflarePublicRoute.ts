import { FORK_CLI_NAME, FORK_DISPLAY_NAME } from "./forkBrand.ts";

/** What the account token needs, as the Cloudflare dashboard names it. */
export const CLOUDFLARE_TOKEN_PERMISSIONS = [
  "Account · Cloudflare Tunnel · Edit",
  "Zone · DNS · Edit",
  "Zone · Zone · Read",
] as const;

// `dns` and `zone` are documented template keys; `argotunnel` is the Tunnel group's key in practice but
// undocumented, and user-token templates drop unknown keys silently, so the UI also lists the permissions.
const TOKEN_TEMPLATE_KEYS = [
  { key: "argotunnel", type: "edit" },
  { key: "dns", type: "edit" },
  { key: "zone", type: "read" },
];

export const CLOUDFLARE_TOKEN_TEMPLATE_URL = `https://dash.cloudflare.com/profile/api-tokens?${new URLSearchParams(
  {
    permissionGroupKeys: JSON.stringify(TOKEN_TEMPLATE_KEYS),
    accountId: "*",
    zoneId: "all",
    name: `${FORK_DISPLAY_NAME} public routes`,
  },
).toString()}`;

/** Deterministic, so any desktop holding the token can find, adopt, or clean up an environment's tunnel. */
export const PUBLIC_ROUTE_TUNNEL_PREFIX = `${FORK_CLI_NAME}-`;
export const publicRouteTunnelName = (environmentId: string) =>
  `${PUBLIC_ROUTE_TUNNEL_PREFIX}${environmentId}`;

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function encodeBase32(bytes: Uint8Array): string {
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return output;
}

/** `kn-` plus 128 random bits as 26 base32 characters, one label under the zone. */
export function makePublicRouteHostname(zone: string, randomBytes: Uint8Array): string {
  if (randomBytes.length !== 16) throw new Error("A public route hostname needs 16 random bytes.");
  return `kn-${encodeBase32(randomBytes)}.${zone.toLowerCase()}`;
}
