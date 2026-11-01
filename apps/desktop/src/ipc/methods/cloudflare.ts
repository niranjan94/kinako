import {
  DesktopCloudflareProvisionedRouteSchema,
  DesktopCloudflareProvisionInputSchema,
  DesktopCloudflareStateSchema,
  DesktopCloudflareTunnelSchema,
  DesktopCloudflareVerifyInputSchema,
  DesktopCloudflareZoneSchema,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopCloudflare from "../../backend/DesktopCloudflare.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const service = DesktopCloudflare.DesktopCloudflare;

export const cloudflareGetState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CLOUDFLARE_GET_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopCloudflareStateSchema,
  handler: () => Effect.flatMap(service, (cloudflare) => cloudflare.getState),
});

export const cloudflareConnect = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CLOUDFLARE_CONNECT_CHANNEL,
  payload: Schema.String,
  result: Schema.Array(DesktopCloudflareZoneSchema),
  handler: (token) => Effect.flatMap(service, (cloudflare) => cloudflare.connect(token)),
});

export const cloudflareListZones = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CLOUDFLARE_LIST_ZONES_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(DesktopCloudflareZoneSchema),
  handler: () => Effect.flatMap(service, (cloudflare) => cloudflare.listZones),
});

export const cloudflareSelectZone = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CLOUDFLARE_SELECT_ZONE_CHANNEL,
  payload: Schema.String,
  result: DesktopCloudflareStateSchema,
  handler: (zoneId) => Effect.flatMap(service, (cloudflare) => cloudflare.selectZone(zoneId)),
});

export const cloudflareDisconnect = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CLOUDFLARE_DISCONNECT_CHANNEL,
  payload: Schema.Void,
  result: DesktopCloudflareStateSchema,
  handler: () => Effect.flatMap(service, (cloudflare) => cloudflare.disconnect),
});

export const cloudflareProvision = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CLOUDFLARE_PROVISION_CHANNEL,
  payload: DesktopCloudflareProvisionInputSchema,
  result: DesktopCloudflareProvisionedRouteSchema,
  handler: (input) => Effect.flatMap(service, (cloudflare) => cloudflare.provision(input)),
});

export const cloudflareRotate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CLOUDFLARE_ROTATE_CHANNEL,
  payload: DesktopCloudflareProvisionInputSchema,
  result: DesktopCloudflareProvisionedRouteSchema,
  handler: (input) => Effect.flatMap(service, (cloudflare) => cloudflare.rotate(input)),
});

export const cloudflareRemove = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CLOUDFLARE_REMOVE_CHANNEL,
  payload: EnvironmentId,
  result: Schema.Void,
  handler: (environmentId) =>
    Effect.flatMap(service, (cloudflare) => cloudflare.remove(environmentId)),
});

export const cloudflareRemoveTunnel = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CLOUDFLARE_REMOVE_TUNNEL_CHANNEL,
  payload: Schema.String,
  result: Schema.Void,
  handler: (tunnelId) => Effect.flatMap(service, (cloudflare) => cloudflare.removeTunnel(tunnelId)),
});

export const cloudflareListTunnels = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CLOUDFLARE_LIST_TUNNELS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(DesktopCloudflareTunnelSchema),
  handler: () => Effect.flatMap(service, (cloudflare) => cloudflare.listTunnels),
});

export const cloudflareVerify = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CLOUDFLARE_VERIFY_CHANNEL,
  payload: DesktopCloudflareVerifyInputSchema,
  result: Schema.Boolean,
  handler: (input) => Effect.flatMap(service, (cloudflare) => cloudflare.verify(input)),
});
