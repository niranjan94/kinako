# Usage and limits

Track token usage, cache hit rates, estimated API-equivalent costs, and pooled subscription quotas across all connected environments.

- **Open Usage**: Click **Usage** in the sidebar, press `mod+u` (web/desktop outside terminals), or pick **Usage** on mobile.
- **Quick shortcuts** (web/desktop on Usage): `C` (Cost), `T` (Tokens), `L` (Limits), `M` (Machine), `mod+Shift+1/2/3/4` (24h / 7d / 30d / 90d; not on Limits or Machine), `Esc` (back).

## Understand your usage

Usage aggregates history across Codex, Claude Code, Grok Build, OpenCode, Antigravity, Pi, Muse Code, and Cursor from your selected environments. Estimates reflect API-equivalent rates (not your subscription bill); **Premium** shows Fast/Ultrafast surcharge, and **Other** shows unsplit provider-reported costs.

- **Retention**: Servers keep scanned usage history for **92 days** by default (preserving Claude history after Claude's 30-day cleanup). Change `usageHistoryRetentionDays` in `<t3-home>/userdata/settings.json` (e.g. `365` or `"unlimited"`; views show up to 90 days).
- **Custom data directories**: Honors `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `GROK_HOME`, `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR`, `OPENCODE_DATA_DIR`, `ANTIGRAVITY_DATA_DIR`, and `XDG_DATA_HOME` (Muse). Use absolute or `~/` paths. Set `T3CODE_HOST_ID` to pin a container's host identity.
- **Exclusions**: Codex and Claude Code 2.0.63+ text-generation runs (titles, commits, PR text, review guides) and Grok turns without a saved completed-turn record are not included.

## Custom model prices and filtering

- **Custom prices & model mapping**: Open the environment dropdown on **Usage → Model prices** (or click **Set price** on an unpriced model) to set USD per million input/output/cache tokens, or set **Map to** to merge a preview/alias model ID into a target model's totals.
- **Filter models**: Add `usageModelFilter` to `<t3-home>/userdata/settings.json` (applied before **Map to**):

```json
{
  "usageModelFilter": {
    "include": [{ "provider": "claude", "model": "orbit-1" }, { "model": "orbit-2" }],
    "exclude": [{ "model": "drift-9" }]
  }
}
```

## Subscription limits

**Usage → Limits** pools subscription quotas per provider across connected environments and hubs (deduplicating the same account signed in on multiple machines).

- **In chat**: Run `/usage-limits` in the composer to view the current model's snapshot without running the agent, or enable **Settings → Appearance → Thread details → Usage limits** (web/desktop).
- **Reset credits**: Click an account segment/row to inspect plan details and redeem banked Codex/Claude reset credits via **Use reset** (Claude resets unavailable on macOS Keychain logins).
- **Provider notes**:
  - **OpenCode**: OpenCode 2 servers with usage reporting show Go allowances and Console budgets for the connected workspace. Local servers can also report Go usage from a Go API key (`OPENCODE_API_KEY`).
  - **Cursor**: Reports monthly Auto + API quotas via `CURSOR_AUTH_TOKEN` or default-endpoint sign-in/`CURSOR_API_KEY`.
  - **Grok**: Reports billing-period quotas for `grok login` (not `XAI_API_KEY`).
  - **Muse Code**: Reports session/weekly limits after running in a thread (not persisted across restarts).
  - Pure API-key accounts generally do not report subscription limits.
- **Mobile widget**: Add the **Subscription usage** widget on iOS or Android to monitor Codex and Claude quotas from your home screen.

## Connect a CLIProxyAPI hub

Open **Settings → Providers → Usage providers → Add hub**, choose the environment, and enter the hub URL and management key. Pools Codex, Claude, and Grok accounts under **Usage → Limits** (including Codex **Use reset**); Antigravity and other providers' accounts are not read. Configure the provider's endpoint to the same URL if you want threads to display that hub's limits, for example `http://127.0.0.1:8317` for both.

- **Quota forecast** (web/desktop): Open **Usage → Limits → Quota forecast** and select a hub. Choose a quota window on each provider card, or switch to **Drain rate** to see how quickly the pool has been spending. The dashed line estimates future quota from the selected burn-rate period and the hub's reported reset times; change **Future usage** to try a different spending rate. Emails stay hidden until you choose **Show emails**.
- **Quota history**: The environment saves 30 days of quota readings from its regular hub checks. The graph fills in after you connect the hub, the forecast appears once enough usage has been observed, and missed checks leave gaps. Antigravity readings saved before the hub stopped reading Antigravity accounts stay in the history until they age out.
- **Claude through the hub**: Once the hub can serve Claude requests, a separate **Claude (hub name)** provider appears. Select it when starting a thread to use the hub. It uses the default Claude provider's runtime settings with the hub's endpoint, credential, and model list, and matching models share favorites and default effort levels with the default Claude provider. Kinako refreshes the model list and credential on hub checks and hides the provider while the hub is unavailable.
- Remove the hub from **Usage providers** to remove both its usage data and its Claude provider. To send other providers' requests through the hub, configure their endpoints separately.

## Connect an HTTP quota source

Open **Settings → Providers → Usage providers → Add HTTP source** with a GET endpoint (and optional bearer token) returning:

```json
{
  "version": 1,
  "accounts": [
    {
      "id": "primary",
      "label": "My coding plan",
      "providerInstanceId": "work-codex",
      "windows": [
        {
          "id": "monthly",
          "kind": "monthly",
          "label": "Monthly budget",
          "usedPercent": 35,
          "resetsAt": "2026-12-01T00:00:00Z"
        }
      ]
    }
  ]
}
```

`kind` is `session`, `weekly`, `monthly`, or `other`. Setting `providerInstanceId` binds the quota windows to that instance's thread details card.

## Check machine usage

**Usage → Machine** shows the CPU, memory, and disk use of each selected environment's machine, refreshed every few seconds while the view is open. Below each reading, a graph shows the past 24 hours: each server samples every 30 seconds, and the shaded band above the line marks the highest reading in each step, so short spikes stay visible. History is kept in memory and starts again when the server restarts. When the server runs in a container or a resource-limited cgroup, CPU and memory are measured against those limits rather than the whole host. Disk is the volume that holds the environment's data directory, where its worktrees and database live. Environments running an older server show current CPU and memory only, without disk or history.
