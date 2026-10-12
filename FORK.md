# Fork maintenance

This repository is a fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) that ships its own builds and sends no traffic to upstream's infrastructure. Remote access is LAN, Tailscale, and SSH only; T3 Connect is not built in.

## Syncing with upstream

`main` holds upstream plus this fork's changes. Upstream comes in by merging, never rebasing, so history keeps its real order and `main` is never rewritten:

```bash
git remote add upstream https://github.com/pingdotgg/t3code.git   # once
git fetch upstream
git checkout main && git pull
git merge upstream/main
git push origin main
```

Resolving conflicts:

- `pnpm-lock.yaml`: never hand-merge it. Take upstream's copy (`git checkout --theirs pnpm-lock.yaml`), then run `pnpm install` to regenerate it.
- `.github/workflows/ci.yml`: take upstream's copy (`git checkout --theirs .github/workflows/ci.yml`), then rerun the runner substitution below.

`git diff upstream/main...main` shows everything this fork changes. Merge before cutting a release so it carries upstream's latest fixes. Check the Actions tab after merging and disable any workflow upstream added.

## What this fork changes

| Change                                                                                                                      | Where                                                                            |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Product telemetry off by default; upstream PostHog key removed                                                              | `apps/server/src/telemetry/AnalyticsService.ts`                                  |
| CLI self-update, `t3 update`, SSH remote installs, mobile environment updates, and install scripts use this repo's releases | `packages/shared/src/cliRelease.ts`, `scripts/install.sh`, `scripts/install.ps1` |
| Model manifest fetched from this repo                                                                                       | `apps/server/src/provider/ModelManifest.ts`                                      |
| Pairing links stay on the server's own origin instead of `app.t3.codes`                                                     | `apps/web/src/components/settings/pairingUrls.ts`                                |
| Desktop release-notes links point at this repo                                                                              | `apps/web/src/components/desktopUpdate.logic.ts`                                 |
| `.env.example` no longer carries upstream's production Clerk and relay values                                               | `.env.example`                                                                   |
| Upstream CI runs on GitHub-hosted runners instead of Blacksmith, with doubled job timeouts                                  | `.github/workflows/ci.yml`                                                       |
| Fork release workflow                                                                                                       | `.github/workflows/fork-release.yml`                                             |

Merge conflicts come from fork changes that touch the same lines as upstream. Keep new patches out of `package.json` versions, `pnpm-lock.yaml`, upstream workflows, and busy UI files. Prefer new fork-only files and environment variables.

## CI

Upstream's `ci.yml` runs unchanged except for its runners. GitHub's standard runners are free for public repositories but have half the cores of upstream's Blacksmith machines, so job timeouts are doubled. The substitution is safe to rerun:

```bash
perl -pi -e 'if (s/blacksmith-\d+vcpu-ubuntu-2404/ubuntu-24.04/ || s/blacksmith-\d+vcpu-macos-26/macos-26/) { $d = 1; next } if ($d && s/^(    timeout-minutes: )(\d+)$/$1 . $2 * 2/e) { $d = 0 }' .github/workflows/ci.yml
```

CI and `fork-release.yml` use Ubuntu 24.04, matching upstream. Playwright does not support Ubuntu 26.04 yet, so the server browser tests cannot install Chromium there. Linux release artifacts also link against the build machine's glibc, so a 26.04 build would not start on older distributions.

## One-time setup

1. **Actions:** enable Actions for the fork, then disable every upstream workflow except `ci.yml` and `release-desktop.yml`. The others expect upstream's runners, secrets, and accounts, and would otherwise queue or fail on every push. `fork-release.yml` calls `release-desktop.yml`.

   ```bash
   gh workflow list --repo niranjan94/t3code --all --json path --jq '.[].path' \
     | grep -v -e '/ci.yml$' -e fork-release.yml -e release-desktop.yml \
     | xargs -n1 basename | xargs -I{} gh workflow disable {} --repo niranjan94/t3code
   ```

## Releasing

Actions → **Fork release** → Run workflow on `main`. The version defaults to upstream's version in `apps/server/package.json`; pass one explicitly to re-release with fork-only fixes, for example `0.0.46` once upstream ships it. The workflow builds unsigned macOS, Windows, and Linux installers plus CLI archives and publishes them as a GitHub Release here.

- Install the CLI with `curl -fsSL https://raw.githubusercontent.com/niranjan94/t3code/main/scripts/install.sh | sh`.
- Desktop auto-update follows this repo's releases on Windows and Linux. macOS refuses updates for unsigned apps, so download new versions by hand there. Remove the quarantine flag after installing: `xattr -dr com.apple.quarantine "/Applications/T3 Code (Alpha).app"`.
- Windows SmartScreen warns on unsigned installers; choose **More info → Run anyway**.

Adding the signing secrets that `release-desktop.yml` already reads (`CSC_LINK`, `APPLE_API_*`, `AZURE_*`, …) turns on signing without workflow changes.

## Not covered yet

- iOS builds through TestFlight: your own bundle ID and Expo project, and OTA updates pointed away from upstream's Expo project.
- Upstream links left as-is because they are user-initiated: marketing and legal pages, the `t3 triage` playbook, the npm `t3` package in upgrade hints, and the `app.t3.codes` entry in `packages/shared/src/providerAuthReturnUrl.ts`.
