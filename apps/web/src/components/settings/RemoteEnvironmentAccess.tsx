import { useAtomValue } from "@effect/atom-react";
import { connectionRoutes } from "@t3tools/client-runtime/connection";
import type {
  AdvertisedEndpoint,
  DesktopSshEnvironmentTarget,
  DesktopSshNetworkAccessState,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useEffect, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { isLoopbackHostname } from "~/environments/primary";
import type { EnvironmentPresentation } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { usePreparedConnection } from "~/state/session";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { advertisedEndpointsFromDirect } from "./ConnectionsSettings.logic";
import { SettingsRow } from "./settingsLayout";

const EMPTY_ADVERTISED_ENDPOINTS: ReadonlyArray<AdvertisedEndpoint> = [];

/**
 * The address another device can pair through. Relay and SSH tunnel URLs only
 * reach the environment from this client, so those links share the code alone.
 */
function directPairingBaseUrl(connection: {
  readonly target: { readonly _tag: string };
  readonly httpBaseUrl: string;
}): string | null {
  if (connection.target._tag !== "BearerConnectionTarget") return null;
  try {
    return isLoopbackHostname(new URL(connection.httpBaseUrl).hostname)
      ? null
      : connection.httpBaseUrl;
  } catch {
    return null;
  }
}

/** Where pairing links for another environment can point: its direct URL and advertised addresses. */
export function useRemotePairingEndpoints(environmentId: EnvironmentId | null): {
  readonly endpointUrl: string | null;
  readonly endpoints: ReadonlyArray<AdvertisedEndpoint>;
} {
  const preparedConnection = usePreparedConnection(environmentId);
  const directEndpoints = useAtomValue(
    serverEnvironment.configValueAtom(environmentId),
  )?.directEndpoints;
  return {
    endpointUrl: Option.isSome(preparedConnection)
      ? directPairingBaseUrl(preparedConnection.value)
      : null,
    endpoints:
      directEndpoints === undefined
        ? EMPTY_ADVERTISED_ENDPOINTS
        : advertisedEndpointsFromDirect(directEndpoints),
  };
}

export function sshRouteTarget(
  entry: EnvironmentPresentation["entry"],
): DesktopSshEnvironmentTarget | null {
  for (const route of connectionRoutes(entry)) {
    if (
      route.target._tag === "SshConnectionTarget" &&
      Option.isSome(route.profile) &&
      route.profile.value._tag === "SshConnectionProfile"
    ) {
      return route.profile.value.target;
    }
  }
  return null;
}

/** Shown while this device holds an SSH tunnel to the server, the only time its binding is known. */
export function SshNetworkAccessSetting({
  target,
  label,
}: {
  readonly target: DesktopSshEnvironmentTarget;
  readonly label: string;
}) {
  const desktopBridge = window.desktopBridge;
  const [state, setState] = useState<DesktopSshNetworkAccessState | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads this target's SSH network access from the desktop bridge
  useEffect(() => {
    if (!desktopBridge) return;
    let cancelled = false;
    desktopBridge.getSshNetworkAccess(target).then(
      (next) => {
        if (!cancelled) setState(next);
      },
      () => {
        if (!cancelled) setState(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [desktopBridge, target]);

  const handleChange = async (enabled: boolean) => {
    if (!desktopBridge) return;
    const confirmed = await requestConfirmDialog(
      enabled
        ? `Enable network access for ${label}?\nOther devices on its network can connect to it directly once you pair them. Its server will restart.`
        : `Disable network access for ${label}?\nDevices connected over its network will disconnect. Its server will restart.`,
    );
    if (confirmed !== true) return;
    setIsUpdating(true);
    return await (async () => {
      const next = await desktopBridge.setSshNetworkAccess(target, enabled);
      if (next !== null) setState(next);
    })()
      .catch(async (error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not update network access",
            description: error instanceof Error ? error.message : "The SSH host did not respond.",
          }),
        );
      })
      .finally(() => {
        setIsUpdating(false);
      });
  };

  if (!desktopBridge || state === null) return null;
  const external = state.serverKind === "external";
  return (
    <SettingsRow
      title="Network access"
      description={
        external
          ? "This server was started on the host itself, so its network access is set there."
          : state.networkAccess
            ? "Other devices on its network can reach it."
            : "Reachable only through SSH from this device."
      }
      control={
        <Switch
          checked={state.networkAccess}
          disabled={external || isUpdating}
          onCheckedChange={(checked) => void handleChange(checked)}
          aria-label={`Network access for ${label}`}
        />
      }
    />
  );
}
