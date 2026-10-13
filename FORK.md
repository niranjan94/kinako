# Fork maintenance

This repository is a fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) that ships as **Kinako**, with its own builds, and sends no traffic to upstream's infrastructure. It installs and runs alongside upstream T3 Code without sharing any state. Remote access is LAN, Tailscale, and SSH only; T3 Connect is not built in.

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
- `README.md`: keep this fork's copy (`git checkout --ours README.md`), then port anything from upstream's change that still applies, such as new providers or docs links.

`git diff upstream/main...main` shows everything this fork changes. Merge before cutting a release so it carries upstream's latest fixes. Check the Actions tab after merging and disable any workflow upstream added.

## What this fork changes

| Change                                                                                                                                   | Where                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Product telemetry off by default; upstream PostHog key removed                                                                           | `apps/server/src/telemetry/AnalyticsService.ts`                                                     |
| CLI self-update, `kinako update`, SSH remote installs, mobile environment updates, and install scripts use this repo's releases          | `packages/shared/src/cliRelease.ts`, `scripts/install.sh`, `scripts/install.ps1`                    |
| Model manifest fetched from this repo                                                                                                    | `apps/server/src/provider/ModelManifest.ts`                                                         |
| Pairing links stay on the server's own origin instead of `app.t3.codes`                                                                  | `apps/web/src/components/settings/pairingUrls.ts`                                                   |
| Desktop release-notes links point at this repo                                                                                           | `apps/web/src/components/desktopUpdate.logic.ts`                                                    |
| `.env.example` no longer carries upstream's production Clerk and relay values                                                            | `.env.example`                                                                                      |
| Upstream CI runs on GitHub-hosted runners instead of Blacksmith, with doubled job timeouts                                               | `.github/workflows/ci.yml`                                                                          |
| Fork nightly release workflow                                                                                                            | `.github/workflows/fork-release.yml`                                                                |
| Settings → About shows the repository and commit a CI build came from                                                                    | `apps/web/vite.config.ts`, `apps/web/src/components/settings/SettingsPanels.tsx`                    |
| Kinako identity: display name, `~/.kinako`, `kinako` CLI and release archives, desktop app ID, URL schemes, service names, default ports | `packages/shared/src/forkBrand.ts`, imported by each call site; see [Rebrand seams](#rebrand-seams) |
| Mobile identity: bundle IDs, Apple team, EAS project `@niranjan94/kinako`, no Clerk associated domains                                   | `apps/mobile/app.config.ts`, `apps/mobile/eas.json`                                                 |
| PR worktrees are only reused from this environment's own worktree folders, so upstream's are never adopted                               | `apps/server/src/git/GitManager.ts`                                                                 |

Merge conflicts come from fork changes that touch the same lines as upstream. Keep new patches out of `package.json` versions, `pnpm-lock.yaml`, upstream workflows, and busy UI files. Prefer new fork-only files and environment variables.

## Rebrand seams

Kinako's identity lives in `packages/shared/src/forkBrand.ts`. Call sites import from it instead of carrying literals, so most upstream changes merge cleanly; a conflict on one of these lines usually means upstream touched the same literal, and the fix is to keep the import. Internal names stay upstream's on purpose: the `@t3tools/*` scope, contract names, `T3CODE_*` environment variables, and the worktree-local `.t3` dev directory.

Some files cannot import TypeScript and repeat the values. Re-check them when merging upstream changes to them:

- `scripts/install.sh`, `scripts/install.ps1`: home directory, archive stem, executable and launcher names.
- `apps/desktop/scripts/electron-launcher.mjs`: dev display name, bundle ID, URL scheme.
- `apps/desktop/src/compileCache.ts`: compile cache directory.
- `apps/desktop/gnome-extension/`: extension UUID, D-Bus name and path, allowed client names (mirrored in `apps/desktop/src/snapShot/LinuxSnapShot.ts`).
- `apps/desktop/resources/linux/io.niranjan.kinako.metainfo.xml`, `apps/desktop/package.json` (`productName`).
- `apps/mobile/src/widgets/AgentActivity.tsx`: widget deep link scheme (widgets are serialized, so they cannot import).
- `packages/contracts/src/settings.ts`: default SnapShot shortcut (contracts do not depend on shared).
- `.github/workflows/fork-release.yml`, `.github/workflows/release-desktop.yml`: `kinako-*` archive globs.

The icon glyph is in `assets/{prod,nightly,dev}/app-icon.icon/Assets/text.svg`, `assets/prod/logo.svg`, both `T3Wordmark.tsx` components, `apps/mobile/assets/widget/T3Mark.svg`, the Android notification drawable, and the DMG backgrounds. After changing it, run `vp run icons:export` (needs Icon Composer.app) and `vp run icons:export:android`. The dev icon's `annotations.svg` still draws dimension lines for the old T3 glyph.

Upstream code that grows a new `t3code://` link, `~/.t3` path, `t3` executable reference, `com.t3tools.t3code` ID, or 3773 default needs the same treatment. Grep for them after each merge.

## Moving from T3 Code to Kinako

Earlier builds of this fork installed as T3 Code and kept their data in `~/.t3`. To move once:

1. Stop the old install: quit the desktop app and run `t3 service uninstall` if you installed the background service.
2. Move the data: `mv ~/.t3 ~/.kinako`. If upstream T3 Code also uses `~/.t3` on this machine, copy instead (`cp -a ~/.t3 ~/.kinako`) and leave upstream's copy alone.
3. Remove the old launcher and app: `rm ~/.local/bin/t3` (if it points into `~/.t3`) and delete the old `T3 Code (Nightly)` app.
4. Install Kinako: `curl -fsSL https://raw.githubusercontent.com/niranjan94/t3code/main/scripts/install.sh | T3CODE_CHANNEL=nightly sh`, then `kinako service install` if you want the background service, and install the Kinako desktop app.

What does not carry over:

- **Saved remote environments in the desktop app** are encrypted with a key tied to the app's name on macOS and Linux. Delete `~/.kinako/userdata/connection-catalog.json` before the first launch and add them again.
- **Paired phones and browsers** stored the old port (3773) and `t3code://` links. Pair them again against port 3873.
- **The "No project" Scratch project** is recorded at `~/.t3/scratch`. Kinako creates a new one under `~/.kinako/scratch`; archive the old entry. Screenshots in older messages also link to `~/.t3/userdata`.
- **SnapShot setup** on Linux (GNOME extension, KDE and Hyprland helpers, Niri and Hyprland bindings) installs under new names. Run setup again from Settings, and remove the old `snap-shot@t3.codes` extension and old bindings unless upstream T3 Code uses them.

Desktop client preferences (drafts, layout, theme) are copied once from the old `t3code-v2` profile on first launch. If you use Tailscale Serve, it now defaults to port 8443.

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

This fork ships nightlies only: `main` tracks upstream's `main`, not its release tags, so its builds match upstream's nightly train rather than a stable version.

Actions → **Fork release** → Run workflow on `main`, usually after merging upstream and seeing CI pass. The version follows upstream's nightly scheme, `<next patch>-nightly.<UTC date>.<run number>` (for example `0.0.46-nightly.20261012.2`), and the release is published here as a prerelease named with the commit it was built from. The workflow builds unsigned macOS, Windows, and Linux installers plus CLI archives.

- Install the CLI with `curl -fsSL https://raw.githubusercontent.com/niranjan94/t3code/main/scripts/install.sh | T3CODE_CHANNEL=nightly sh`. Without it the script installs from the stable channel, which this fork does not publish. An installed nightly CLI updates along the nightly channel on its own.
- The desktop app installs as **Kinako (Nightly)** and follows the nightly update channel. Auto-update works on Windows and Linux. macOS refuses updates for unsigned apps, so download new versions by hand there. Remove the quarantine flag after installing: `xattr -dr com.apple.quarantine "/Applications/Kinako (Nightly).app"`.
- Windows SmartScreen warns on unsigned installers; choose **More info → Run anyway**.

Adding the signing secrets that `release-desktop.yml` already reads (`CSC_LINK`, `APPLE_API_*`, `AZURE_*`, …) turns on signing without workflow changes.

## Not covered yet

- Mobile releases. The app has its own bundle IDs, Apple team (`6456AUQBLS`), and EAS project, but no App Store Connect app or Play listing yet, so `eas.json` has no submit target for iOS. The Clerk config plugin is still loaded even though the fork does not use Clerk.
- Upstream links left as-is because they are user-initiated: marketing and legal pages, the `t3 triage` playbook, the npm `t3` package in upgrade hints, and the `app.t3.codes` entry in `packages/shared/src/providerAuthReturnUrl.ts`.
- Most "T3 Code" strings in the UI, CLI messages, and docs. Only the names users see first (window titles, installers, permission prompts, the sidebar) say Kinako.
- `AGENTS.md` still calls `~/.t3/userdata` the live database; for this fork it is `~/.kinako/userdata`.
