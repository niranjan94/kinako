# Fork maintenance

This repository is a fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) that ships its own
builds and sends no traffic to upstream's infrastructure. Remote access is LAN, Tailscale, and SSH only;
T3 Connect is not built in.

## Syncing with upstream

`main` holds upstream plus this fork's changes. Upstream comes in by merging, never rebasing, so
history keeps its real order and `main` is never rewritten:

```bash
git remote add upstream https://github.com/pingdotgg/t3code.git   # once
git fetch upstream
git checkout main && git pull
git merge upstream/main         # resolve conflicts; never hand-merge pnpm-lock.yaml:
                                # take upstream's copy, then run `pnpm install` to regenerate it
git push origin main
```

`git diff upstream/main...main` shows everything this fork changes. Merge before cutting a release
so it carries upstream's latest fixes.

## What this fork changes

| Change                                                                                                                      | Where                                                                            |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Product telemetry off by default; upstream PostHog key removed                                                              | `apps/server/src/telemetry/AnalyticsService.ts`                                  |
| CLI self-update, `t3 update`, SSH remote installs, mobile environment updates, and install scripts use this repo's releases | `packages/shared/src/cliRelease.ts`, `scripts/install.sh`, `scripts/install.ps1` |
| Model manifest fetched from this repo                                                                                       | `apps/server/src/provider/ModelManifest.ts`                                      |
| Pairing links stay on the server's own origin instead of `app.t3.codes`                                                     | `apps/web/src/components/settings/pairingUrls.ts`                                |
| Desktop release-notes links point at this repo                                                                              | `apps/web/src/components/desktopUpdate.logic.ts`                                 |
| `.env.example` no longer carries upstream's production Clerk and relay values                                               | `.env.example`                                                                   |
| Fork release workflow                                                                                                       | `.github/workflows/fork-release.yml`                                             |

Merge conflicts come from fork changes that touch the same lines as upstream. Keep new patches
out of `package.json` versions, `pnpm-lock.yaml`, upstream workflows, and busy UI
files. Prefer new fork-only files and environment variables.

## One-time setup

1. **Actions:** enable Actions for the fork, then disable every upstream workflow. They expect
   upstream's runners, secrets, and accounts, and would otherwise queue or fail on every push.
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

## Releasing

Actions → **Fork release** → Run workflow on `main`. The version defaults to upstream's version in
`apps/server/package.json`; pass one explicitly to re-release with fork-only fixes, for example
`0.0.46` once upstream ships it. The workflow builds unsigned macOS, Windows, and Linux installers plus
CLI archives and publishes them as a GitHub Release here.

- Install the CLI with
  `curl -fsSL https://raw.githubusercontent.com/niranjan94/t3code/main/scripts/install.sh | sh`.
- Desktop auto-update follows this repo's releases on Windows and Linux. macOS refuses updates for
  unsigned apps, so download new versions by hand there. Remove the quarantine flag after installing:
  `xattr -dr com.apple.quarantine "/Applications/T3 Code (Alpha).app"`.
- Windows SmartScreen warns on unsigned installers; choose **More info → Run anyway**.

Adding the signing secrets that `release-desktop.yml` already reads (`CSC_LINK`, `APPLE_API_*`,
`AZURE_*`, …) turns on signing without workflow changes.

## Not covered yet

- Mobile builds (needs an Apple Developer account, your own bundle ID and Expo project, and OTA
  updates pointed away from upstream's Expo project).
- Upstream links left as-is because they are user-initiated: marketing and legal pages, the
  `t3 triage` playbook, the npm `t3` package in upgrade hints, and the `app.t3.codes` entry in
  `packages/shared/src/providerAuthReturnUrl.ts`.
