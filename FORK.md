# Fork maintenance

This repository is a fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) that ships its own
builds and sends no traffic to upstream's infrastructure. Remote access is LAN, Tailscale, and SSH only;
T3 Connect is not built in.

## Branches

- `main` is an exact mirror of upstream `main`. Never commit to it.
- `fork/main` is the default branch: upstream plus this fork's patch layer, kept small and rebased.
  `git log main..fork/main` is the complete list of what this fork changes.

`fork-sync.yml` fast-forwards `main` and rebases `fork/main` every 6 hours. Rebasing rewrites
`fork/main`, so after a sync run reset any local checkout with `git fetch && git reset --hard origin/fork/main`.

## What the patch layer changes

| Change                                                                                                                      | Where                                                                            |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Product telemetry off by default; upstream PostHog key removed                                                              | `apps/server/src/telemetry/AnalyticsService.ts`                                  |
| CLI self-update, `t3 update`, SSH remote installs, mobile environment updates, and install scripts use this repo's releases | `packages/shared/src/cliRelease.ts`, `scripts/install.sh`, `scripts/install.ps1` |
| Model manifest fetched from this repo                                                                                       | `apps/server/src/provider/ModelManifest.ts`                                      |
| Pairing links stay on the server's own origin instead of `app.t3.codes`                                                     | `apps/web/src/components/settings/pairingUrls.ts`                                |
| Desktop release-notes links point at this repo                                                                              | `apps/web/src/components/desktopUpdate.logic.ts`                                 |
| `.env.example` no longer carries upstream's production Clerk and relay values                                               | `.env.example`                                                                   |
| Fork workflows                                                                                                              | `.github/workflows/fork-*.yml`                                                   |

Keep new patches out of `package.json` versions, `pnpm-lock.yaml`, upstream workflows, and busy UI
files. Prefer new fork-only files and environment variables.

## One-time setup

1. **Default branch:** Settings → General → Default branch → `fork/main`. Scheduled workflows only run
   from the default branch.
2. **Actions:** enable Actions for the fork, then disable every upstream workflow. They expect
   upstream's runners, secrets, and accounts, and would otherwise queue or fail on every sync.
   Keep `release-desktop.yml` enabled, since `fork-release.yml` calls it.

   ```bash
   for wf in ci release deploy-relay desktop-macos-preview desktop-macos-preview-publish \
     mobile-eas-preview mobile-eas-production mobile-fingerprint-check mobile-showcase-screenshots \
     web-preview publish-aur pr-size pr-vouch issue-labels thread-transfer-report \
     cursor-hygiene-webhook windows-tests; do
     gh workflow disable "$wf.yml" --repo niranjan94/t3code
   done
   ```

   Re-run this when upstream adds a workflow.

3. **Sync token:** create a fine-grained personal access token limited to this repository with
   **Contents: read and write** and **Workflows: read and write**, and save it as the
   `FORK_SYNC_TOKEN` Actions secret. The default `GITHUB_TOKEN` cannot push upstream's workflow changes.

## Releasing

Actions → **Fork release** → Run workflow on `fork/main`. The version defaults to upstream's version in
`apps/server/package.json`; pass one explicitly to re-release with fork-only fixes, for example
`0.0.46` once upstream ships it. The workflow builds unsigned macOS, Windows, and Linux installers plus
CLI archives and publishes them as a GitHub Release here.

- Install the CLI with
  `curl -fsSL https://raw.githubusercontent.com/niranjan94/t3code/refs/heads/fork/main/scripts/install.sh | sh`.
- Desktop auto-update follows this repo's releases on Windows and Linux. macOS refuses updates for
  unsigned apps, so download new versions by hand there. Remove the quarantine flag after installing:
  `xattr -dr com.apple.quarantine "/Applications/T3 Code (Alpha).app"`.
- Windows SmartScreen warns on unsigned installers; choose **More info → Run anyway**.

Adding the signing secrets that `release-desktop.yml` already reads (`CSC_LINK`, `APPLE_API_*`,
`AZURE_*`, …) turns on signing without workflow changes.

## Fixing a failed sync

When `fork/main` stops rebasing cleanly, the sync job still mirrors `main`, leaves `fork/main` as it
was, and fails. Rebase by hand:

```bash
git fetch origin
git checkout fork/main && git reset --hard origin/fork/main
git rebase origin/main          # resolve conflicts; never hand-merge pnpm-lock.yaml, regenerate it
git push --force-with-lease origin fork/main
```

## Not covered yet

- Mobile builds (needs an Apple Developer account, your own bundle ID and Expo project, and OTA
  updates pointed away from upstream's Expo project).
- Upstream links left as-is because they are user-initiated: marketing and legal pages, the
  `t3 triage` playbook, the npm `t3` package in upgrade hints, and the `app.t3.codes` entry in
  `packages/shared/src/providerAuthReturnUrl.ts`.
