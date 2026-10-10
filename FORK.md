# Fork maintenance

This repository is a fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) that ships its own
builds and sends no traffic to upstream's infrastructure. Remote access is LAN, Tailscale, and SSH only;
T3 Connect is not built in.

## Branches

- `main` is an exact mirror of upstream `main`. Never commit to it.
- `fork/main` is the default branch: upstream plus this fork's changes. Upstream comes in through
  merges, so `fork/main` is never rewritten. `git diff main...fork/main` shows everything this fork
  changes.

Every 6 hours `fork-sync.yml` fast-forwards `main` to upstream and, when `fork/main` is behind, opens a
**chore(fork): sync upstream** pull request from `main` into `fork/main`. One PR stays open and keeps
picking up new upstream commits until you merge it. Always merge it with a **merge commit**; squashing
or rebasing would make the next sync replay the same upstream history.

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

Conflicts on the sync PR come from fork changes that touch the same lines as upstream. Keep new
patches out of `package.json` versions, `pnpm-lock.yaml`, upstream workflows, and busy UI
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
   **Contents**, **Workflows**, and **Pull requests** set to read and write, and save it as the
   `FORK_SYNC_TOKEN` Actions secret. The default `GITHUB_TOKEN` cannot push upstream's workflow changes.
4. **Merge button:** Settings → General → Pull Requests, keep **Allow merge commits** enabled.

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

## Resolving a conflicted sync PR

Small conflicts can be fixed in GitHub's web editor. Otherwise merge locally and push; the PR closes as
merged:

```bash
git fetch origin
git checkout fork/main && git pull
git merge origin/main           # resolve conflicts; never hand-merge pnpm-lock.yaml:
                                # take main's copy, then run `pnpm install` to regenerate it
git push origin fork/main
```

Sync before cutting a release, so the release carries upstream's latest fixes.

## Not covered yet

- Mobile builds (needs an Apple Developer account, your own bundle ID and Expo project, and OTA
  updates pointed away from upstream's Expo project).
- Upstream links left as-is because they are user-initiated: marketing and legal pages, the
  `t3 triage` playbook, the npm `t3` package in upgrade hints, and the `app.t3.codes` entry in
  `packages/shared/src/providerAuthReturnUrl.ts`.
