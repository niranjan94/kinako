import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthStandardClientScopes,
  AuthTerminalOperateScope,
  type DesktopCloudflareTunnel,
  type DesktopCloudflareZone,
  type EnvironmentId,
  type PublicRouteStatus,
} from "@t3tools/contracts";
import {
  CLOUDFLARE_TOKEN_PERMISSIONS,
  CLOUDFLARE_TOKEN_TEMPLATE_URL,
} from "@t3tools/shared/cloudflarePublicRoute";
import * as Redacted from "effect/Redacted";
import { useEffect, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { authEnvironment } from "~/state/auth";
import {
  desktopCloudflareBridge,
  desktopCloudflareErrorMessage,
  desktopCloudflareStateAtom,
  refreshDesktopCloudflareState,
} from "~/state/desktopCloudflare";
import { publicRouteEnvironment } from "~/state/publicRoute";
import { useEnvironmentSessionScopes } from "~/state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { QRCodeSvg } from "../ui/qr-code";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { resolveDesktopPairingUrl } from "./pairingUrls";
import { SecretInput } from "./SecretInput";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const STATE_LABELS: Record<PublicRouteStatus["state"], string> = {
  off: "Off",
  connecting: "Connecting to Cloudflare…",
  live: "Live",
  rejected: "Cloudflare rejected the tunnel, so the host stopped it.",
  "cloudflared-missing": "Installing cloudflared on the host…",
  failed: "The tunnel connector failed to start.",
};

// A just-created DNS record can take a while to answer, so a failed check is retried.
const VERIFY_RETRY_MS = 15_000;

// A phone needs the standard permissions, but not a shell on the host.
const PHONE_SCOPES = AuthStandardClientScopes.filter((scope) => scope !== AuthTerminalOperateScope);

const reportError = (title: string, error: unknown) =>
  toastManager.add(
    stackedThreadToast({ type: "error", title, description: desktopCloudflareErrorMessage(error) }),
  );

export function usePublicRouteStatus(environmentId: EnvironmentId): PublicRouteStatus | null {
  const result = useAtomValue(publicRouteEnvironment.status({ environmentId, input: {} }));
  return result._tag === "Success" ? result.value : null;
}

/** Whether the hostname answers as this environment, checked from the desktop once the host says it is live. */
function useRouteVerified(environmentId: EnvironmentId, status: PublicRouteStatus | null) {
  const hostname = status?.state === "live" ? status.hostname : null;
  const [verified, setVerified] = useState<{ hostname: string; ok: boolean } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the desktop to fetch the public hostname once it goes live
  useEffect(() => {
    const bridge = desktopCloudflareBridge();
    if (!bridge || hostname === null) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const check = () =>
      void bridge.verify({ hostname, environmentId }).then((ok) => {
        if (cancelled) return;
        setVerified({ hostname, ok });
        if (!ok) retry = setTimeout(check, VERIFY_RETRY_MS);
      });
    check();
    return () => {
      cancelled = true;
      clearTimeout(retry);
    };
  }, [environmentId, hostname]);
  return verified !== null && verified.hostname === hostname ? verified.ok : null;
}

function describeStatus(status: PublicRouteStatus, verified: boolean | null): string {
  if (status.state !== "live" || status.hostname === null) {
    return status.detail && status.state === "failed"
      ? `${STATE_LABELS.failed} ${status.detail}`
      : STATE_LABELS[status.state];
  }
  if (verified === false)
    return `https://${status.hostname} is not answering as this environment yet.`;
  return `https://${status.hostname}`;
}

function AddToPhoneDialog({
  label,
  pairing,
  onOpenChange,
}: {
  readonly label: string;
  readonly pairing: { readonly url: string | null; readonly error: string | null };
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Add {label} to a phone</DialogTitle>
          <DialogDescription>
            Scan with the mobile app. The code works once, for five minutes, and does not grant
            terminal control.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col items-center gap-3">
            {pairing.url ? (
              <QRCodeSvg value={pairing.url} size={196} level="M" title="Pairing QR code" />
            ) : pairing.error ? (
              <p className="text-xs text-destructive">{pairing.error}</p>
            ) : (
              <p className="text-xs text-muted-foreground">Creating a pairing code…</p>
            )}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

/** The switch, status, and actions for one environment's public route. */
export function PublicRouteSetting({
  environmentId,
  label,
  layout = "row",
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly layout?: "row" | "inline";
}) {
  const bridge = desktopCloudflareBridge();
  const status = usePublicRouteStatus(environmentId);
  const verified = useRouteVerified(environmentId, status);
  const cloudflare = useAtomValue(desktopCloudflareStateAtom);
  const canWrite = useAtomValue(publicRouteEnvironment.enable.permissionAtom(environmentId));
  const enableRoute = useAtomCommand(publicRouteEnvironment.enable, { reportFailure: false });
  const disableRoute = useAtomCommand(publicRouteEnvironment.disable, { reportFailure: false });
  const createPairingLink = useAtomCommand(authEnvironment.createPairingLink, {
    reportFailure: false,
  });
  const grantedScopes = useEnvironmentSessionScopes(environmentId);
  const [busy, setBusy] = useState(false);
  const [pairing, setPairing] = useState<{
    readonly url: string | null;
    readonly error: string | null;
  } | null>(null);

  if (status === null) return null;
  const configured = status.state !== "off" && status.state !== "rejected";
  const zoneReady = cloudflare._tag === "Success" && cloudflare.value.zone !== null;
  // Without the desktop, only an existing route is shown.
  if (!bridge && !configured) return null;

  const handOver = async (
    provision: () => Promise<{
      readonly hostname: string;
      readonly tunnelId: string;
      readonly connectorToken: string;
    }>,
  ) => {
    const route = await provision();
    const result = await enableRoute({
      environmentId,
      input: {
        hostname: route.hostname,
        tunnelId: route.tunnelId,
        connectorToken: Redacted.make(route.connectorToken),
      },
    });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  };

  const run = async (title: string, action: () => Promise<void>) => {
    setBusy(true);
    await action()
      .catch((error: unknown) => reportError(title, error))
      .finally(() => setBusy(false));
  };

  const turnOn = () =>
    run("Could not turn on the public route", () =>
      handOver(() => bridge!.provision({ environmentId, originPort: status.originPort })),
    );

  const turnOff = async () => {
    const confirmed = await requestConfirmDialog(
      `Turn off the public route for ${label}?\nDevices using it lose their connection, and its address stops working.`,
    );
    if (confirmed !== true) return;
    await run("Could not turn off the public route", async () => {
      const result = await disableRoute({ environmentId, input: {} });
      // An unreachable host still loses the route: deleting the tunnel closes it at Cloudflare.
      if (result._tag === "Failure" && !zoneReady) throw squashAtomCommandFailure(result);
      if (zoneReady) await bridge?.remove(environmentId);
    });
  };

  const rotate = async () => {
    const confirmed = await requestConfirmDialog(
      `Give ${label} a new public address?\nThe current one keeps working for ten minutes so connected devices can move over.`,
    );
    if (confirmed !== true) return;
    await run("Could not rotate the address", () =>
      handOver(() => bridge!.rotate({ environmentId, originPort: status.originPort })),
    );
  };

  // Each opening mints one single-use pairing code on the host.
  const addToPhone = async (hostname: string) => {
    setPairing({ url: null, error: null });
    const result = await createPairingLink({
      environmentId,
      input: {
        label: "Phone",
        scopes: PHONE_SCOPES.filter((scope) => grantedScopes?.includes(scope) ?? false),
      },
    });
    setPairing(
      result._tag === "Failure"
        ? { url: null, error: desktopCloudflareErrorMessage(squashAtomCommandFailure(result)) }
        : {
            url: resolveDesktopPairingUrl(`https://${hostname}`, result.value.credential),
            error: null,
          },
    );
  };

  const description =
    !configured && !zoneReady
      ? "Connect a Cloudflare account under Public routes to reach this environment from anywhere."
      : describeStatus(status, verified);
  const actions =
    bridge && configured && canWrite ? (
      <div className="flex flex-wrap gap-1">
        {status.state === "live" && status.hostname ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => status.hostname && void addToPhone(status.hostname)}
          >
            Add to phone
          </Button>
        ) : null}
        {zoneReady ? (
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => void rotate()}>
            Rotate address
          </Button>
        ) : null}
      </div>
    ) : null;
  const control = (
    <Switch
      checked={configured}
      disabled={busy || !canWrite || !bridge || (!configured && !zoneReady)}
      onCheckedChange={(checked) => void (checked ? turnOn() : turnOff())}
      aria-label={`Public route for ${label}`}
    />
  );
  const dialog = pairing ? (
    <AddToPhoneDialog label={label} pairing={pairing} onOpenChange={() => setPairing(null)} />
  ) : null;

  if (layout === "inline") {
    return (
      <div className="flex flex-col gap-2 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground">Public route</p>
            <p className="break-all text-xs text-muted-foreground">{description}</p>
          </div>
          {control}
        </div>
        {actions}
        {dialog}
      </div>
    );
  }
  return (
    <>
      <SettingsRow title="Public route" description={description} control={control}>
        {actions}
      </SettingsRow>
      {dialog}
    </>
  );
}

function ConnectCloudflareForm() {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const connect = async () => {
    const bridge = desktopCloudflareBridge();
    if (!bridge || token.trim().length === 0) return;
    setBusy(true);
    await bridge
      .connect(token)
      .then(() => {
        setToken("");
        refreshDesktopCloudflareState();
      })
      .catch((error: unknown) => reportError("Could not connect Cloudflare", error))
      .finally(() => setBusy(false));
  };
  return (
    <div className="flex flex-col gap-3 px-4 py-3 sm:px-5">
      <p className="text-xs text-muted-foreground">
        Reach your environments over the internet through Cloudflare Tunnel, on your own account and
        domain, without a VPN on your phone.{" "}
        <a
          className="underline"
          href={CLOUDFLARE_TOKEN_TEMPLATE_URL}
          target="_blank"
          rel="noreferrer"
        >
          Create an API token
        </a>{" "}
        with these permissions, then paste it here. It stays on this computer.
      </p>
      <ul className="list-disc pl-5 text-xs text-muted-foreground">
        {CLOUDFLARE_TOKEN_PERMISSIONS.map((permission) => (
          <li key={permission}>{permission}</li>
        ))}
      </ul>
      <div className="flex gap-2">
        <SecretInput
          placeholder="Cloudflare API token"
          value={token}
          onChange={(event) => setToken(event.currentTarget.value)}
          aria-label="Cloudflare API token"
        />
        <Button
          size="sm"
          disabled={busy || token.trim().length === 0}
          onClick={() => void connect()}
        >
          Connect
        </Button>
      </div>
    </div>
  );
}

function ZonePicker({ zone }: { readonly zone: DesktopCloudflareZone | null }) {
  const [zones, setZones] = useState<ReadonlyArray<DesktopCloudflareZone> | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- lists the domains the stored token can manage, from the desktop
  useEffect(() => {
    const bridge = desktopCloudflareBridge();
    if (!bridge) return;
    let cancelled = false;
    bridge.listZones().then(
      (next) => {
        if (!cancelled) setZones(next);
      },
      (error: unknown) => reportError("Could not list Cloudflare domains", error),
    );
    return () => {
      cancelled = true;
    };
  }, []);
  const choose = async (zoneId: string) => {
    try {
      await desktopCloudflareBridge()?.selectZone(zoneId);
      refreshDesktopCloudflareState();
    } catch (error) {
      reportError("Could not choose the domain", error);
    }
  };
  const options = zones ?? (zone ? [zone] : []);
  return (
    <Select
      value={zone?.id ?? null}
      onValueChange={(value) => {
        if (typeof value === "string") void choose(value);
      }}
    >
      <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Cloudflare domain">
        <SelectValue>
          {(value: string | null) =>
            options.find((option) => option.id === value)?.name ?? "Choose a domain"
          }
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {options.map((option) => (
          <SelectItem key={option.id} hideIndicator value={option.id}>
            {option.name} ({option.accountName})
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function TunnelList({
  environments,
}: {
  readonly environments: ReadonlyArray<{ readonly environmentId: string; readonly label: string }>;
}) {
  const [tunnels, setTunnels] = useState<ReadonlyArray<DesktopCloudflareTunnel> | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- lists this account's tunnels from Cloudflare through the desktop
  useEffect(() => {
    const bridge = desktopCloudflareBridge();
    if (!bridge) return;
    let cancelled = false;
    bridge.listTunnels().then(
      (next) => {
        if (!cancelled) setTunnels(next);
      },
      () => {
        if (!cancelled) setTunnels([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);
  if (tunnels === null || tunnels.length === 0) return null;
  const labels = new Map(environments.map((entry) => [entry.environmentId, entry.label]));
  const remove = async (tunnel: DesktopCloudflareTunnel) => {
    const confirmed = await requestConfirmDialog(
      `Delete the tunnel ${tunnel.name}?\nIts address stops working, and the host drops its connector.`,
    );
    if (confirmed !== true) return;
    setRemoving(tunnel.tunnelId);
    await (desktopCloudflareBridge()?.removeTunnel(tunnel.tunnelId) ?? Promise.resolve())
      .then(() =>
        setTunnels(
          (current) => current?.filter((entry) => entry.tunnelId !== tunnel.tunnelId) ?? null,
        ),
      )
      .catch((error: unknown) => reportError("Could not delete the tunnel", error))
      .finally(() => setRemoving(null));
  };
  return (
    <div className="flex flex-col gap-1 px-4 py-3 sm:px-5">
      <p className="text-xs font-medium text-foreground">Tunnels on this account</p>
      {tunnels.map((tunnel) => (
        <div key={tunnel.tunnelId} className="flex items-center justify-between gap-3">
          <p className="min-w-0 truncate text-xs text-muted-foreground">
            {labels.get(tunnel.environmentId) ?? `${tunnel.name} (no known environment)`}
          </p>
          <Button
            size="xs"
            variant="ghost-destructive"
            disabled={removing === tunnel.tunnelId}
            onClick={() => void remove(tunnel)}
          >
            Delete
          </Button>
        </div>
      ))}
    </div>
  );
}

/** Settings → Environments → Public routes: the Cloudflare account the desktop provisions with. */
export function PublicRoutesSection({
  environments,
}: {
  readonly environments: ReadonlyArray<{ readonly environmentId: string; readonly label: string }>;
}) {
  const state = useAtomValue(desktopCloudflareStateAtom);
  const [revision, setRevision] = useState(0);
  if (!desktopCloudflareBridge() || state._tag !== "Success") return null;
  const { connected, zone, encryptionAvailable } = state.value;

  const disconnect = async () => {
    const confirmed = await requestConfirmDialog(
      "Disconnect Cloudflare?\nExisting public routes keep working. Delete their tunnels first if you want them gone; without the token this app cannot.",
    );
    if (confirmed !== true) return;
    try {
      await desktopCloudflareBridge()?.disconnect();
      refreshDesktopCloudflareState();
    } catch (error) {
      reportError("Could not disconnect Cloudflare", error);
    }
  };

  return (
    <SettingsSection {...searchableSetting("public-routes")} title="Public routes">
      {!encryptionAvailable ? (
        <p className="px-4 py-3 text-xs text-muted-foreground sm:px-5">
          This system has no secure storage for the Cloudflare token, so public routes are
          unavailable.
        </p>
      ) : !connected ? (
        <ConnectCloudflareForm />
      ) : (
        <>
          <SettingsRow
            title="Cloudflare domain"
            description={
              zone
                ? `New public routes get a random address under ${zone.name}.`
                : "Choose the domain public routes live under."
            }
            control={<ZonePicker zone={zone} />}
          >
            <div className="flex gap-1">
              <Button size="xs" variant="ghost" onClick={() => setRevision((value) => value + 1)}>
                Refresh tunnels
              </Button>
              <Button size="xs" variant="ghost-destructive" onClick={() => void disconnect()}>
                Disconnect Cloudflare
              </Button>
            </div>
          </SettingsRow>
          {zone ? <TunnelList key={revision} environments={environments} /> : null}
        </>
      )}
    </SettingsSection>
  );
}
