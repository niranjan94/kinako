import { buildHostedPairingUrl } from "../../hostedPairing";
import { setPairingTokenOnUrl } from "@t3tools/shared/remote";

export function resolveDesktopPairingUrl(endpointUrl: string, credential: string): string {
  const url = new URL(endpointUrl);
  url.pathname = "/pair";
  return setPairingTokenOnUrl(url, credential).toString();
}

export function resolveHostedPairingUrl(endpointUrl: string, credential: string): string | null {
  const url = new URL(endpointUrl);
  // Fork: without a hosted app of our own, links stay on the server's origin
  // instead of handing the token to upstream's app.t3.codes.
  if (url.protocol !== "https:" || !import.meta.env.VITE_HOSTED_APP_URL?.trim()) {
    return null;
  }

  return buildHostedPairingUrl({
    host: endpointUrl,
    token: credential,
  });
}
