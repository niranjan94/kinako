import { FORK_CLI_NAME } from "./forkBrand.ts";

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
