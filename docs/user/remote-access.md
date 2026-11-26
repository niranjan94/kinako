# Remote access

Drive Kinako from your phone, browser, or another desktop app while your agents run on a host computer or server. The host must stay awake and running while you work.

A host stays awake while agents work unless you turn that off; see [Keep the computer awake](./background-service.md#keep-the-computer-awake).

## T3 Connect

T3 Connect is upstream T3 Code’s hosted service. In Kinako, use a [public route](#public-routes-with-your-cloudflare-account) to reach your host over the internet.

- **Desktop host**: Open **Settings → Sharing & access**, sign in, and turn on **T3 Connect** (note: closing the desktop app's last window stops its local server—use the [background service](./background-service.md) for unattended access).
- **CLI / headless host**: Run `t3 up` (or `t3 connect` / `t3 up --connect --lan --yes` for non-interactive scripts) and complete the printed sign-in link on any device. Check status with `t3 status [--json]`.
- **Other devices**: Sign in to the same T3 Connect account and pick the environment.

### Approve new devices

By default, any device signed into your T3 Connect account can connect. Turn on **Require approval for new devices** in **Settings → Sharing & access** on the host so new devices must present a short code (valid 10 minutes) that you approve from an existing device or via `t3 auth connect-device approve <code>`. Revoke devices anytime in **Settings → Sharing & access** or `t3 auth connect-device revoke <code>`.

### More machines with T3 Chat

Free T3 Connect accounts can link up to **3 host machines** (phones and browsers don't count). Link a paid T3 Chat account from your account menu → **T3 Chat → Link T3 Chat** to raise the limit to **10** (Pro) or **100** (Premier).

## Pair over a LAN or private network

- **Desktop host**: Enable **Settings → Sharing & access → Network access** (restarts desktop) and create a one-time pairing link.
- **CLI host**. Run `kinako up --lan` for the background service or `kinako serve --lan` for a foreground server, then run `kinako pair` to generate a QR code and pairing URL. `kinako://pair` opens in the Kinako app.
- **Hosted web app (`app.t3.codes`)**: Requires an HTTPS endpoint (T3 Connect or Tailscale HTTPS). For plain HTTP on a LAN, open the direct pairing URL in a local browser or pair from the desktop/mobile app. For custom CAs on Android, install the CA certificate in Android security settings.
- **Session lifetime**: Paired devices stay signed in while active; sessions unused for 30 days must re-pair.

### Reach one machine several ways

A host can have multiple routes (LAN, Tailscale, VPN, public URL, SSH, T3 Connect). T3 Code automatically learns LAN and Tailscale routes when network access is enabled, connects over the fastest working route, and switches back to higher-priority routes when you return home. Reorder or add routes in **Settings → Environments** (**Add route**).

While the machine is connected and your session there can manage access, **Add route** needs only the address: leave the pairing code empty and the machine issues one over its current connection. In the web and desktop apps, a live [public route](#public-routes-with-your-cloudflare-account) that is not saved yet shows in the route list with **Add**.

### Tailscale HTTPS

Join both devices to a tailnet with [MagicDNS and HTTPS certificates](https://tailscale.com/docs/how-to/set-up-https-certificates) enabled (on Linux, grant [operator permission](https://tailscale.com/docs/reference/troubleshooting/linux/linux-operator-permission)).

- **Desktop**: Enable **Settings → Sharing & access → Tailscale HTTPS**.
- **CLI**. Run `kinako serve --tailscale-serve` or `kinako pair --tailscale`. The default HTTPS port is 8443. Use `--tailscale-serve-port` to change it. To remove the default route, run `tailscale serve --https=8443 --set-path=/ off`.

### Balance new threads across machines

On web and desktop with 2+ connected machines, enable **Settings → Environments → Load balancing** (per client) to auto-select a host for new threads in shared projects. Set each machine to **Prefer**, **Normal**, **Less often**, or **Manual only**.

## Public routes with your Cloudflare account

A public route makes an environment reachable from anywhere, including a phone on mobile data, through a Cloudflare Tunnel on your own Cloudflare account and domain. Nothing runs on a VPN, no router ports open, and Cloudflare's free plan covers it. You need a domain whose DNS is on Cloudflare.

Set it up from the desktop app:

1. Open **Settings → Environments → Public routes** and select **Create an API token**. The link opens Cloudflare with these permissions filled in; check they are all there before creating the token:
   - Account · Cloudflare Tunnel · Edit
   - Zone · DNS · Edit
   - Zone · Zone · Read
2. Paste the token and select **Connect**, then choose the domain if the token can see more than one. The token stays on this computer, encrypted by the operating system. The machines you expose never receive it.
3. Turn on **Public route** for an environment: under **Settings → Sharing & access**, choosing a remote one with **Showing access for**. Remote environments added over SSH work too; the host only needs outbound internet access.

Each route gets a long random address such as `https://kn-….example.com`. Nobody needs to type it:

- **Add to phone** shows a QR code with the address and a one-time pairing code. The code expires after five minutes and does not grant terminal control.
- A phone already paired over your local network or Tailscale learns the public route the next time it connects, and uses it when the other routes are out of reach.

Anyone who learns the address reaches the environment's sign-in, the same as with T3 Connect; pairing codes and sessions still protect it. If an address leaks, select **Rotate address**. The old address keeps working for ten minutes so connected devices can move over, then stops.

To remove a route, turn off **Public route**. The host stops its connector, and the desktop deletes the tunnel and its DNS record, even if the host is offline. **Public routes** also lists every tunnel this app created on the account, including ones whose environment is gone, so you can delete them. Disconnecting Cloudflare leaves existing routes running; delete their tunnels first if you want them gone.

## Desktop-managed SSH

In the desktop app, open **Settings → Environments → Add environment → SSH** and enter a host or SSH alias (e.g. `user@example.com`). Kinako downloads its server to `~/.kinako/runtime` on the Linux or Apple Silicon macOS host, starts or reuses a server, and manages port forwarding automatically.

- Provider CLIs must be on a non-interactive login shell's `PATH` (check with `ssh user@example.com 'sh -lc "command -v claude codex"'`).
- For 2FA/Duo hosts on macOS/Linux, enable SSH `ControlMaster` in `~/.ssh/config` and open a terminal SSH session first.
- When the server falls behind the app, update it from the app like any other environment. A server the app launched over SSH downloads the new version and restarts itself; there is nothing to run on the host.
- The server listens only on the host's loopback address. To pair a phone or another computer with it directly, open **Settings → Sharing & access**, choose the environment in **Showing access for**, and turn on **Network access**. The server restarts on the host's network, and new pairing links offer a QR code for each of its LAN and Tailscale addresses. The setting belongs to the host; a server you started on the host yourself keeps its own binding.
- Revoke unused SSH sessions in **Settings → Sharing & access** or `kinako auth session revoke <id>`.

## Browser on a remote environment

Browser tabs belong to the host environment so you and your agents share them from any device.

- **Streaming & local loading**: Web and mobile stream tabs from the host. In the desktop app, tabs you open for a remote environment load locally while routing `localhost` requests to the host over the **preview tunnel** (so element picker and annotations work locally).
- **Port forwarding (desktop)**: Forward any remote host port to your local `localhost` via the thread's **Servers** list or **Forwarded ports** in the command palette (`Cmd/Ctrl-click` forwards and opens in your browser).
- **Open on this device (mobile)**: Tap **Open on this device** on a streamed `localhost` tab or long-press a `localhost` link in chat for native touch scrolling.
- **Disable preview tunnel**: Turn off **Settings → Sharing & access → Preview tunnel** on the host (or via [managed policy](./managed-policy.md#other-capabilities)) to disable port forwarding and **Open on this device** (streamed tabs continue working).
- **Take control**: Click **Take control** before typing into an agent's tab, and release control when done.
- **Local servers**: T3 Code lists listening ports from your terminals and agents as `http://localhost:<port>` (set a script's **Preview URL** for HTTPS or subpaths). Disable discovery with `T3CODE_PORT_DISCOVERY=0`.

### Browser host setup

The first server browser tab downloads ~120 MB headless Chromium (shared with [HTML renders](./html-renders.md)). On Ubuntu 23.10+ or minimal Linux containers, run the one-time setup command on the host:

```sh
sudo kinako browser setup
```

This installs an AppArmor profile for Chrome's sandbox plus missing libraries and fonts. Never run the T3 server as root (Chrome's sandbox rejects root); if sandboxing is impossible on your host, set `T3CODE_SERVER_BROWSER_SANDBOX=0` in the server environment and restart.

## Link another environment

Link two T3 Code machines (beta) so agents on one can launch, message, delegate to, and manage threads on the other.

1. Enable **Settings → Labs → Linked environments** on **both** machines (or `"linkedEnvironmentsEnabled": true` in `userdata/settings.json`, `~/.kinako/userdata/settings.json` by default).
2. On the source machine, open **Settings → Environments → Linked environments → Link** (or drag from one machine's `+` to another on the Environments map, or run `kinako environment link <address> --pairing-code <code> --access <mode>`). Use **Link several…** or `--from <file>` for batch linking (make each code with `kinako pair` on that machine).
3. Links are one-way (tick **Also link … back** for two-way) and do not chain. Links expire after 30 days of inactivity and can be revoked in **Settings → Sharing & access** or **Forget**.

- **Access boundary**: Agents never get more permissions on the target than the link's access level or their own thread mode. Below Full access, linked agents can only modify threads they started and skip project setup scripts.
- **Delegation**: Agents can target a linked machine with `delegate_task`, or ask you to link an unlinked machine via an in-thread approval card.

### Read a linked machine's threads

Open a delegated task or thread link on a linked machine to follow it live (read-only) in the right panel without pairing your client directly. Click **Connect to interact** to pair and take action (one-click if the link has Full access and you can manage access). Files, images, and HTML renders stay on the remote machine until you connect directly.

## Manage or revoke access

Manage pairing links and active client sessions in **Settings → Sharing & access** or via `kinako auth --help`. From another device, open **Clients** on a saved environment’s row. Your client needs access permissions there, which environments added over SSH grant automatically. SSH routes share a pairing code because only the device with the SSH connection can reach them.

- **Scoped tokens**. Pass `--scope <scope>` to `kinako pair`, `kinako auth pairing create`, or `kinako auth session issue` to restrict permissions. Repeat the flag for each scope you want to grant. Re-pair with a fresh link to change an existing client’s scopes.
- **Deregister from T3 Connect**: Open your account menu → **T3 Connect → Deregister** (or `t3 connect unlink` / `t3 connect logout` on CLI hosts). Idle tunnels are automatically cleaned up after 5–10 minutes offline and recreated on reconnect (hosts on older versions offline for 7+ days need an update first).
- Treat pairing URLs and codes as passwords—never paste them into logs or screenshots.

## Desktop app as a remote only

Switch off **Settings → Environments → Local environment** in the desktop app to run with no local server, WSL backend, or incoming connections while continuing to drive remote hosts (if a local background service uses the same T3 home, **Open in** still works locally).

## Troubleshooting

See [T3 Connect troubleshooting](./t3-connect-troubleshooting.md) for step-by-step connection diagnostics, and [Outside agents](./outside-agents.md) for MCP connections.
