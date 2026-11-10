import type { ScheduledTaskWebhookEndpoint } from "@t3tools/contracts";
import { FORK_DISPLAY_NAME } from "@t3tools/shared/forkBrand";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";

const PUBLIC_ROUTE_HINT = `Turn on a public route from the ${FORK_DISPLAY_NAME} desktop app for a public URL.`;

export interface WebhookAddress {
  readonly address: string;
  readonly copyable: boolean;
  readonly note: string | null;
}

export function webhookAddress(
  endpoint: ScheduledTaskWebhookEndpoint,
  httpBaseUrl: string | null,
): WebhookAddress {
  if (endpoint.url !== null) {
    return { address: endpoint.url, copyable: true, note: null };
  }
  if (httpBaseUrl === null) {
    return {
      address: endpoint.path,
      copyable: false,
      note: PUBLIC_ROUTE_HINT,
    };
  }
  const url = new URL(endpoint.path, httpBaseUrl);
  return {
    address: url.href,
    copyable: true,
    note: isLocalLoopbackHost(url.hostname)
      ? `Only this computer can call this address. ${PUBLIC_ROUTE_HINT}`
      : `Works wherever this environment's address is reachable, for example over Tailscale or your own proxy. ${PUBLIC_ROUTE_HINT}`,
  };
}
