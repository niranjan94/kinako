import { SessionPermissions } from "./SessionPermissions";
import {
  ChevronRightIcon,
  ChevronsLeftRightEllipsisIcon,
  EllipsisIcon,
  QrCodeIcon,
  RouteIcon,
} from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useEffectEvent, useState } from "react";
import {
  AuthRelayWriteScope,
  type AdvertisedEndpoint,
  type DesktopSshEnvironmentTarget,
  type DesktopSshNetworkAccessState,
  type EnvironmentId,
  connectReachabilityHelpUrl,
  formatConnectReachable,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import {
  connectionRoutes,
  hasSavedBearerRoute,
  connectionStatusText,
  environmentMcpUrl,
} from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { EnvironmentIconMenu } from "./EnvironmentIconPicker";
import { EnvironmentRoutesList } from "./EnvironmentRoutesList";
import {
  ConnectionDiagnosisPanel,
  ConnectionDiagnosisSummary,
  useConnectionDiagnosis,
} from "./ConnectionDiagnosisDetails";
import { usePreparedConnection } from "~/state/session";
import { EnvironmentRow, environmentTransportLabel } from "./EnvironmentRow";
import { AuthorizedClientsHeaderAction, PairingClientsList } from "./AuthorizedClientsSettings";
import { advertisedEndpointsFromDirect } from "./ConnectionsSettings.logic";
import { useEnvironmentAccessManagement } from "./useEnvironmentAccessManagement";
import { isLoopbackHostname } from "~/environments/primary";
import { requestConfirmDialog } from "~/confirmDialog";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import {
  resolveServerConfigVersionMismatch,
  resolveServerSelfUpdateCapability,
  supportsDesktopAppUpdate,
  supportsServerUpdateThreadContinuation,
} from "~/versionSkew";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { isElectron } from "~/env";
import { useCloudLinkController } from "~/cloud/useCloudLinkController";
import { environmentCatalog } from "~/connection/catalog";
import { readEnvironmentScope } from "~/state/session";
import {
  type EnvironmentPresentation,
  useRelayEnvironmentDiscovery,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import { APP_VERSION } from "~/branding";
import { useAtomCommand } from "../../state/use-atom-command";
import { serverEnvironment } from "~/state/server";
import {
  OutdatedServerUpdateAction,
  ServerUpdateAction,
  ServerUpdateProgress,
} from "../ServerUpdateAction";
import { CloudEnvironmentConnectRows } from "../cloud/CloudEnvironmentConnectList";
import { useT3ConnectAuthPrompt } from "../clerk/useT3ConnectAuthPrompt";

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

function sshRouteTarget(
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
function SshNetworkAccessSetting({
  target,
  label,
}: {
  readonly target: DesktopSshEnvironmentTarget;
  readonly label: string;
}) {
  const desktopBridge = window.desktopBridge;
  const [state, setState] = useState<DesktopSshNetworkAccessState | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);

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
    <div className="flex items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="text-xs font-medium text-foreground">Network access</p>
        <p className="text-xs text-muted-foreground">
          {external
            ? "This server was started on the host itself, so its network access is set there."
            : state.networkAccess
              ? "Other devices on its network can reach it."
              : "Reachable only through SSH from this device."}
        </p>
      </div>
      <Switch
        checked={state.networkAccess}
        disabled={external || isUpdating}
        onCheckedChange={(checked) => void handleChange(checked)}
        aria-label={`Network access for ${label}`}
      />
    </div>
  );
}

function RemoteAuthorizedClients({
  environmentId,
  sshTarget,
  label,
  access,
  id,
}: {
  readonly environmentId: EnvironmentId;
  readonly sshTarget: DesktopSshEnvironmentTarget | null;
  readonly label: string;
  readonly access: ReturnType<typeof useEnvironmentAccessManagement>;
  readonly id: string;
}) {
  const preparedConnection = usePreparedConnection(environmentId);
  const endpointUrl = Option.isSome(preparedConnection)
    ? directPairingBaseUrl(preparedConnection.value)
    : null;
  const directEndpoints = useAtomValue(
    serverEnvironment.configValueAtom(environmentId),
  )?.directEndpoints;
  const endpoints =
    directEndpoints === undefined
      ? EMPTY_ADVERTISED_ENDPOINTS
      : advertisedEndpointsFromDirect(directEndpoints);

  return (
    <div id={id} className="mt-2 border-t border-border/50">
      {sshTarget ? <SshNetworkAccessSetting target={sshTarget} label={label} /> : null}
      {access.canWriteAccess ? (
        <div className="flex flex-wrap items-center justify-between gap-3 py-3">
          <p className="text-xs text-muted-foreground">
            {endpointUrl || endpoints.length > 0
              ? "Pair another device with this environment."
              : "Links share a pairing code. Use it from a client that can reach this environment directly."}
          </p>
          <AuthorizedClientsHeaderAction
            delegatableScopes={access.delegatableScopes}
            onCreatePairingLink={access.createPairingLink}
            clientSessions={access.hasSnapshot ? access.clientSessions : null}
            isRevokingOtherClients={access.isRevokingOtherClients}
            onRevokeOtherClients={access.revokeOtherClients}
          />
        </div>
      ) : null}
      {access.error ? <p className="pb-3 text-xs text-destructive">{access.error}</p> : null}
      {access.canReadAccess ? (
        <PairingClientsList
          endpointUrl={endpointUrl}
          endpoints={endpoints}
          defaultEndpointKey={null}
          shareFromCurrentOrigin={false}
          isLoading={access.isLoading}
          pairingLinks={access.pairingLinks}
          createdPairingCredentials={access.createdPairingCredentials}
          clientSessions={access.clientSessions}
          revokingPairingLinkId={access.revokingPairingLinkId}
          revokingClientSessionId={access.revokingClientSessionId}
          onRevokePairingLink={access.revokePairingLink}
          onRevokeClientSession={access.revokeClientSession}
          canRevoke={access.canWriteAccess}
        />
      ) : (
        <p className="py-3 text-xs text-muted-foreground">
          This connection can create access links but cannot view authorized clients.
        </p>
      )}
    </div>
  );
}

type SavedBackendListRowProps = {
  environment: EnvironmentPresentation;
  removingEnvironmentId: EnvironmentId | null;
  onSetEnabled: (environmentId: EnvironmentId, enabled: boolean) => void;
  onRemove: (environment: EnvironmentPresentation) => void;
  onAddRoute: (environment: EnvironmentPresentation) => void;
};

function savedBackendStatus(environment: EnvironmentPresentation): {
  readonly text: string;
  readonly tone: "muted" | "error";
} {
  if (!environment.entry.enabled && environment.connection.phase !== "unsupported")
    return { text: "Off", tone: "muted" };
  const { connection } = environment;
  switch (connection.phase) {
    case "connected":
      return { text: "Connected", tone: "muted" };
    case "connecting":
      return { text: "Connecting", tone: "muted" };
    case "reconnecting":
      return {
        text: connection.error ? `Reconnecting: ${connection.error}` : "Reconnecting",
        tone: "error",
      };
    case "unsupported":
      return { text: "Client not supported", tone: "muted" };
    case "error":
      return {
        text: connection.error ? `Connection failed: ${connection.error}` : "Connection failed",
        tone: "error",
      };
    case "offline":
      return { text: "Offline", tone: "muted" };
    case "available":
      return { text: "Not connected", tone: "muted" };
  }
}

export function SavedBackendListRow({
  environment,
  removingEnvironmentId,
  onSetEnabled,
  onRemove,
  onAddRoute,
}: SavedBackendListRowProps) {
  const [routesOpen, setRoutesOpen] = useState(false);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [clientsOpen, setClientsOpen] = useState(false);
  const [diagnosisOpen, setDiagnosisOpen] = useState(false);
  const environmentId = environment.environmentId;
  const unsupported = environment.connection.phase === "unsupported";
  const blocked = unsupported && !hasSavedBearerRoute(environment.entry);
  const enabled = environment.entry.enabled && !unsupported;
  const isConnected = environment.connection.phase === "connected";
  const clientsAccess = useEnvironmentAccessManagement(environmentId, clientsOpen && isConnected);
  const canManageClients =
    isConnected && (clientsAccess.canReadAccess || clientsAccess.canWriteAccess);
  const isRemoving = removingEnvironmentId === environmentId;
  const errorTraceId = environment.connection.traceId;
  const { copyToClipboard: copyTraceIdToClipboard } = useCopyToClipboard<{ traceId: string }>({
    target: "trace ID",
    onCopy: ({ traceId }) => {
      toastManager.add({
        type: "success",
        title: "Trace ID copied",
        description: traceId,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy trace ID",
          description: error.message,
        }),
      );
    },
  });
  const copyTraceId = (traceId: string) => {
    copyTraceIdToClipboard(traceId, { traceId });
  };
  const { copyToClipboard: copyMcpUrl } = useCopyToClipboard<{ url: string }>({
    target: "MCP URL",
    onCopy: ({ url }) => {
      toastManager.add({
        type: "success",
        title: "MCP URL copied",
        description: `Add it to an agent, e.g. claude mcp add --transport http t3 ${url}`,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy MCP URL",
          description: error.message,
        }),
      );
    },
  });
  const versionMismatch = resolveServerConfigVersionMismatch(environment.serverConfig);
  const serverUpdateState = useAtomValue(serverEnvironment.updateStateAtom(environmentId));
  const resumingServerUpdate =
    serverUpdateState.status === "running" && serverUpdateState.stage === "resuming";
  const status = savedBackendStatus(environment);
  const serverVersion = environment.serverConfig?.environment.serverVersion ?? null;
  // Discovery empties its map on every refresh, so hold the last descriptor
  // seen or the glyph would blink back to the generic one each time.
  const relayDiscovery = useRelayEnvironmentDiscovery();
  const discoveredDescriptor = Option.getOrNull(
    relayDiscovery.environments.get(environmentId)?.status ?? Option.none(),
  )?.descriptor;
  const [lastDescriptor, setLastDescriptor] = useState(discoveredDescriptor);
  if (discoveredDescriptor !== undefined && discoveredDescriptor !== lastDescriptor) {
    setLastDescriptor(discoveredDescriptor);
  }
  const discoveredRelayHttpBaseUrl =
    relayDiscovery.environments.get(environmentId)?.environment.endpoint.httpBaseUrl;
  const [lastRelayHttpBaseUrl, setLastRelayHttpBaseUrl] = useState(discoveredRelayHttpBaseUrl);
  if (
    discoveredRelayHttpBaseUrl !== undefined &&
    discoveredRelayHttpBaseUrl !== lastRelayHttpBaseUrl
  ) {
    setLastRelayHttpBaseUrl(discoveredRelayHttpBaseUrl);
  }
  const retryNow = useAtomCommand(environmentCatalog.retryNow);
  const {
    diagnosis: currentDiagnosis,
    state: connectionState,
    relayOnly,
  } = useConnectionDiagnosis(environment);
  const diagnosis = resumingServerUpdate ? null : currentDiagnosis;
  const prepared = usePreparedConnection(environmentId);
  const connectedTarget = isConnected && prepared._tag === "Some" ? prepared.value.target : null;
  const mcpUrl = environmentMcpUrl({
    entry: environment.entry,
    relayHttpBaseUrl: discoveredRelayHttpBaseUrl ?? lastRelayHttpBaseUrl,
    connectedTarget,
  });
  const machineKind = resolveEnvironmentMachineKind(
    environment.serverConfig ??
      (lastDescriptor === undefined ? null : { environment: lastDescriptor }),
  );
  const routeCount = connectionRoutes(environment.entry).length;
  const subtitleText = [
    environmentTransportLabel(environment, connectedTarget),
    // The headline below names the failure in full.
    diagnosis ? null : resumingServerUpdate ? "Restarting" : status.text,
    enabled && versionMismatch ? serverVersion : null,
  ]
    .filter((value): value is string => value !== null)
    .join(" · ");

  const showUpdateAction =
    enabled &&
    isConnected &&
    versionMismatch !== null &&
    (serverUpdateState.status === "idle" || serverUpdateState.status === "failed");

  const statusTooltip = `${
    unsupported
      ? (environment.connection.error ?? connectionStatusText(environment.connection))
      : enabled
        ? connectionStatusText(environment.connection)
        : "Switched off"
  }${
    versionMismatch
      ? `\nUpdate available: ${versionMismatch.serverVersion} → ${versionMismatch.clientVersion}`
      : ""
  }`;

  return (
    <EnvironmentRow
      kind={machineKind}
      label={environment.label}
      dimmed={!enabled}
      subtitle={
        <span className="flex min-w-0 items-center gap-1">
          <Tooltip>
            {/* The status can change while the tooltip is open, and base-ui only
                re-measures the popup when the trigger's payload changes. */}
            <TooltipTrigger
              payload={statusTooltip}
              render={
                <span
                  className={cn(
                    "min-w-0 truncate",
                    enabled &&
                      status.tone === "error" &&
                      !resumingServerUpdate &&
                      !diagnosis &&
                      "text-destructive",
                  )}
                />
              }
            >
              {subtitleText}
            </TooltipTrigger>
            <TooltipPopup side="top" className="whitespace-pre-wrap">
              {statusTooltip}
            </TooltipPopup>
          </Tooltip>
          <span aria-hidden className="shrink-0">
            ·
          </span>
          <button
            type="button"
            aria-expanded={routesOpen}
            onClick={() => setRoutesOpen((open) => !open)}
            className="inline-flex shrink-0 items-center gap-0.5 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
          >
            {routeCount === 1 ? "Routes" : `${routeCount} routes`}
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
                routesOpen && "rotate-90",
              )}
            />
          </button>
          <span aria-hidden className="shrink-0">
            ·
          </span>
          <button
            type="button"
            aria-expanded={permissionsOpen}
            aria-controls={`remote-permissions-${environmentId}`}
            onClick={() => setPermissionsOpen((open) => !open)}
            className="inline-flex shrink-0 items-center gap-0.5 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
          >
            Permissions
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
                permissionsOpen && "rotate-90",
              )}
            />
          </button>
          {canManageClients ? (
            <>
              <span aria-hidden className="shrink-0">
                ·
              </span>
              <button
                type="button"
                aria-expanded={clientsOpen}
                aria-controls={`remote-clients-${environmentId}`}
                onClick={() => setClientsOpen((open) => !open)}
                className="inline-flex shrink-0 items-center gap-0.5 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
              >
                Clients
                <ChevronRightIcon
                  aria-hidden
                  className={cn(
                    "size-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
                    clientsOpen && "rotate-90",
                  )}
                />
              </button>
            </>
          ) : null}
        </span>
      }
      below={
        <>
          {diagnosis ? (
            <ConnectionDiagnosisSummary
              diagnosis={diagnosis}
              retryAt={connectionState.phase === "backoff" ? connectionState.retryAt : null}
              attempt={connectionState.attempt}
              expanded={diagnosisOpen}
              onToggle={() => setDiagnosisOpen((open) => !open)}
            />
          ) : null}
          {serverUpdateState.status !== "idle" ? (
            <div className="mt-1 max-w-md">
              <ServerUpdateProgress state={serverUpdateState} />
            </div>
          ) : null}
        </>
      }
      detail={
        <>
          {diagnosis && diagnosisOpen ? (
            <ConnectionDiagnosisPanel
              hostLabel={environment.label}
              diagnosis={diagnosis}
              onRetry={() => void retryNow(environmentId)}
              onAddRoute={relayOnly ? () => onAddRoute(environment) : null}
            />
          ) : null}
          {routesOpen && (
            <EnvironmentRoutesList
              environment={environment}
              onAddRoute={() => onAddRoute(environment)}
            />
          )}
          {permissionsOpen && (
            <div
              id={`remote-permissions-${environmentId}`}
              className="mt-2 border-t border-border/50"
            >
              <SessionPermissions
                environmentId={environmentId}
                connected={isConnected}
                routeContext
              />
            </div>
          )}
          {clientsOpen && canManageClients && (
            <RemoteAuthorizedClients
              environmentId={environmentId}
              sshTarget={sshRouteTarget(environment.entry)}
              label={environment.label}
              access={clientsAccess}
              id={`remote-clients-${environmentId}`}
            />
          )}
        </>
      }
    >
      {unsupported &&
      environment.entry.serverUpdateRequired === true &&
      serverUpdateState.status !== "running" ? (
        <OutdatedServerUpdateAction
          environmentId={environmentId}
          serverLabel={`${environment.label} server`}
          fromVersion={lastDescriptor?.serverVersion}
          targetVersion={APP_VERSION}
          label={serverUpdateState.status === "failed" ? "Retry update" : "Update"}
        />
      ) : null}
      {showUpdateAction ? (
        <ServerUpdateAction
          environmentId={environmentId}
          serverLabel={`${environment.label} server`}
          selfUpdate={resolveServerSelfUpdateCapability(environment.serverConfig)}
          installation={environment.serverConfig?.environment.capabilities.serverInstallation}
          desktopAppUpdate={supportsDesktopAppUpdate(environment.serverConfig)}
          threadContinuation={supportsServerUpdateThreadContinuation(environment.serverConfig)}
          targetVersion={versionMismatch.clientVersion}
          label={serverUpdateState.status === "failed" ? "Retry update" : "Update"}
          appearance="icon"
        />
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Switch
              size="sm"
              checked={enabled}
              disabled={isRemoving || blocked}
              aria-label={`${enabled ? "Switch off" : "Switch on"} ${environment.label}`}
              onCheckedChange={(checked) => onSetEnabled(environmentId, checked)}
            />
          }
        />
        <TooltipPopup side="top">
          {blocked ? "Client not supported" : enabled ? "Switch off" : "Switch on"}
        </TooltipPopup>
      </Tooltip>
      <Menu>
        <MenuTrigger
          render={
            <Button
              type="button"
              variant="ghost-muted"
              size="icon-xs"
              disabled={isRemoving}
              aria-label={`More actions for ${environment.label}`}
            />
          }
        >
          <EllipsisIcon className="size-3.5" />
        </MenuTrigger>
        <MenuPopup align="end">
          <EnvironmentIconMenu
            environmentId={environmentId}
            serverConfig={environment.serverConfig}
          />
          <MenuItem onClick={() => setRoutesOpen((open) => !open)}>
            <RouteIcon />
            {routesOpen ? "Hide routes" : "Routes"}
          </MenuItem>
          {canManageClients ? (
            <MenuItem onClick={() => setClientsOpen((open) => !open)}>
              <QrCodeIcon />
              {clientsOpen ? "Hide clients" : "Authorized clients"}
            </MenuItem>
          ) : null}
          {mcpUrl ? (
            <MenuItem onClick={() => copyMcpUrl(mcpUrl, { url: mcpUrl })}>Copy MCP URL</MenuItem>
          ) : null}
          {errorTraceId ? (
            <MenuItem onClick={() => copyTraceId(errorTraceId)}>Copy trace ID</MenuItem>
          ) : null}
          <MenuSeparator />
          <MenuItem variant="destructive" onClick={() => onRemove(environment)}>
            {isRemoving ? "Removing…" : "Remove from this device…"}
          </MenuItem>
        </MenuPopup>
      </Menu>
    </EnvironmentRow>
  );
}

function CloudLinkSwitch({
  checked,
  disabled,
  disabledReason,
  onCheckedChange,
  ariaLabel = "Enable T3 Connect",
}: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly disabledReason: string | null;
  readonly onCheckedChange?: (enabled: boolean) => void;
  readonly ariaLabel?: string;
}) {
  const control = (
    <Switch
      aria-label={ariaLabel}
      checked={checked}
      disabled={disabled}
      {...(onCheckedChange ? { onCheckedChange } : {})}
    />
  );
  return disabledReason ? (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex">{control}</span>} />
      <TooltipPopup side="top">{disabledReason}</TooltipPopup>
    </Tooltip>
  ) : (
    control
  );
}

function ConfiguredCloudLinkRow({ canManageRelay }: { readonly canManageRelay: boolean }) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const {
    isSignedIn,
    linkState: primaryCloudLinkState,
    linkRevoked,
    managedTunnelActive,
    managedTunnelOutOfSync,
    publishAgentActivity,
    holdWebhooksWhileOffline,
    operationError,
    reconcileCloudState,
  } = useCloudLinkController();
  const { openAuthPrompt } = useT3ConnectAuthPrompt();
  const [isUpdating, setIsUpdating] = useState(false);
  const [isUpdatingPreference, setIsUpdatingPreference] = useState(false);

  const disabledReason = canManageRelay
    ? null
    : "Your session does not have permission to manage T3 Connect access.";
  const isBusy = isUpdating || isUpdatingPreference;
  const switchDisabled =
    !canManageRelay ||
    !isSignedIn ||
    primaryCloudLinkState.data === null ||
    primaryCloudLinkState.isPending ||
    isBusy;
  // `isSignedIn` is undefined until Clerk loads. Signed out, one row shows a
  // sign-in button instead of its switch; the onboarding dialog that opens after
  // a fresh sign-in offers both linking and publishing.
  const signedOut = isSignedIn === false;
  const signInButton = (
    <Button size="sm" variant="outline" onClick={openAuthPrompt}>
      Sign in
    </Button>
  );
  const refreshLinkState = useEffectEvent(primaryCloudLinkState.refresh);
  // The server rechecks reachability when the tunnel's 30 s readiness poll changes.
  // Poll while mounted, so a failed read does not stop later ones.
  useEffect(() => {
    const interval = window.setInterval(() => refreshLinkState(), 30_000);
    return () => window.clearInterval(interval);
  }, []);
  const reachability = managedTunnelActive ? primaryCloudLinkState.data?.reachability : undefined;
  const reachabilityStatus =
    reachability?.status === "reachable" ? (
      formatConnectReachable(reachability)
    ) : reachability?.status === "unreachable" ? (
      <span className="block text-destructive">
        {[reachability.reason, reachability.hint, `Fix: ${reachability.fix}`]
          .filter(Boolean)
          .join(" ")}{" "}
        <a
          href={connectReachabilityHelpUrl(reachability.cause)}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2"
        >
          More info
        </a>
      </span>
    ) : null;

  const updateManagedTunnel = async (enabled: boolean) => {
    if (
      primaryEnvironmentId === null ||
      !readEnvironmentScope(primaryEnvironmentId, AuthRelayWriteScope)
    )
      return;
    setIsUpdating(true);
    const ok = await reconcileCloudState({ managedTunnel: enabled, publish: publishAgentActivity });
    if (ok) {
      toastManager.add({
        type: "success",
        title: enabled
          ? "T3 Connect linked"
          : publishAgentActivity
            ? "T3 Connect tunnel disabled"
            : "T3 Connect unlinked",
        description: enabled
          ? "This environment is available through T3 Connect."
          : publishAgentActivity
            ? "The managed tunnel was removed. Agent activity publishing stays on."
            : "This environment is no longer available through T3 Connect.",
      });
    }
    setIsUpdating(false);
  };

  const updatePublishAgentActivity = async (enabled: boolean) => {
    if (
      primaryEnvironmentId === null ||
      !readEnvironmentScope(primaryEnvironmentId, AuthRelayWriteScope)
    )
      return;
    setIsUpdatingPreference(true);
    const ok = await reconcileCloudState({ managedTunnel: managedTunnelActive, publish: enabled });
    if (ok) {
      toastManager.add({
        type: "success",
        title: enabled ? "Agent activity enabled" : "Agent activity disabled",
        description: enabled
          ? "This environment publishes agent activity to your mobile clients."
          : "This environment will stop publishing agent activity.",
      });
    }
    setIsUpdatingPreference(false);
  };

  const updateHoldWebhooks = async (enabled: boolean) => {
    setIsUpdatingPreference(true);
    const ok = await reconcileCloudState({
      managedTunnel: managedTunnelActive,
      publish: publishAgentActivity,
      holdWebhooksWhileOffline: enabled,
    });
    if (ok) {
      toastManager.add({
        type: "success",
        title: enabled ? "Webhooks held while offline" : "Webhooks no longer held",
        description: enabled
          ? "T3 Connect keeps webhook requests for up to 24 hours while this environment is offline."
          : "Requests to an offline environment now fail. Anything already held is still delivered.",
      });
    }
    setIsUpdatingPreference(false);
  };

  return (
    <>
      {isElectron ? (
        <SettingsRow
          title={searchableSetting("t3-connect").title}
          description={
            signedOut
              ? "Sign in to make this environment available to your other devices through T3 Connect."
              : linkRevoked
                ? "This environment was removed from T3 Connect. Turn it on to link it again."
                : managedTunnelActive
                  ? reachability?.status === "unreachable"
                    ? "T3 Connect is on, but other devices cannot reach this environment."
                    : reachability?.status === "reachable"
                      ? "This environment is available to your other devices through T3 Connect."
                      : "T3 Connect is on. Reachability has not been checked yet."
                  : managedTunnelOutOfSync
                    ? "T3 Connect is out of sync. This environment is linked only to publish agent activity, so other devices cannot connect. Turn T3 Connect on to repair it."
                    : "Make this environment available to your other devices through T3 Connect."
          }
          status={operationError ?? primaryCloudLinkState.error ?? reachabilityStatus}
          control={
            signedOut ? (
              signInButton
            ) : (
              <CloudLinkSwitch
                checked={managedTunnelActive}
                disabled={switchDisabled}
                disabledReason={disabledReason}
                onCheckedChange={(enabled) => void updateManagedTunnel(enabled)}
              />
            )
          }
        />
      ) : linkRevoked ? (
        <SettingsRow
          title={searchableSetting("t3-connect").title}
          description="This environment was removed from T3 Connect. Run `t3 connect link` on the host to link it again."
        />
      ) : null}
      {signedOut && isElectron ? null : (
        <SettingsRow
          title={searchableSetting("publish-agent-activity").title}
          description={
            signedOut
              ? "Sign in to send activity to mobile notifications and Live Activities."
              : "Send activity to mobile notifications and Live Activities without T3 Connect."
          }
          control={
            signedOut ? (
              signInButton
            ) : (
              <CloudLinkSwitch
                ariaLabel="Publish agent activity to mobile clients"
                checked={publishAgentActivity}
                disabled={switchDisabled}
                disabledReason={disabledReason}
                onCheckedChange={(enabled) => void updatePublishAgentActivity(enabled)}
              />
            )
          }
        />
      )}
      {managedTunnelActive && !signedOut ? (
        <SettingsRow
          title={searchableSetting("hold-webhooks-while-offline").title}
          description="Keep webhook requests for up to 24 hours while this environment is offline, then deliver them. Off: T3 Connect only forwards requests and stores nothing."
          control={
            <CloudLinkSwitch
              ariaLabel="Hold webhook requests while this environment is offline"
              checked={holdWebhooksWhileOffline}
              disabled={switchDisabled}
              disabledReason={disabledReason}
              onCheckedChange={(enabled) => void updateHoldWebhooks(enabled)}
            />
          }
        />
      ) : null}
    </>
  );
}

export function CloudLinkRow({
  canReadRelay,
  canManageRelay,
}: {
  readonly canReadRelay: boolean;
  readonly canManageRelay: boolean;
}) {
  if (!hasCloudPublicConfig()) return null;
  if (!canReadRelay) {
    return (
      <SettingsRow
        title="T3 Connect"
        description="To edit these settings, pair this connection with both View relay and Manage relay permissions."
      />
    );
  }
  return <ConfiguredCloudLinkRow canManageRelay={canManageRelay} />;
}

function EmptyRemoteEnvironments({ cloudEnabled = true }: { readonly cloudEnabled?: boolean }) {
  return (
    <Empty className="min-h-52">
      <EmptyMedia variant="icon">
        <ChevronsLeftRightEllipsisIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>No saved remote environments</EmptyTitle>
        <EmptyDescription>
          {cloudEnabled
            ? "Click “Add environment” to pair another environment, or connect one from T3 Connect."
            : "Click “Add environment” to pair another environment."}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function CloudRemoteEnvironmentRows({
  primaryEnvironmentId,
  savedEnvironments,
}: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly savedEnvironments: ReadonlyArray<EnvironmentPresentation>;
}) {
  return hasCloudPublicConfig() ? (
    <CloudEnvironmentConnectRows
      primaryEnvironmentId={primaryEnvironmentId}
      savedEnvironments={savedEnvironments}
      empty={<EmptyRemoteEnvironments />}
    />
  ) : savedEnvironments.length === 0 ? (
    <EmptyRemoteEnvironments cloudEnabled={false} />
  ) : null;
}
