---
name: merge-upstream
description: Merge pingdotgg/t3code's main into this Kinako fork and resolve the conflicts the rebrand causes, keeping Kinako installable next to upstream T3 Code. Use whenever asked to sync with upstream, pull in upstream changes, merge upstream/main, catch up with T3 Code, or resolve conflicts from an upstream merge, even if the request does not mention Kinako or the rebrand.
---

# Merge upstream into Kinako

This repository is a fork of `pingdotgg/t3code` that ships as **Kinako**. Its identity (display name, `~/.kinako`, the `kinako` CLI and release archives, `io.niranjan.kinako` app IDs, `kinako://` schemes, service names, default ports 3873 and 8443, SnapShot helper names) is routed through `packages/shared/src/forkBrand.ts`. FORK.md has the full list under "Rebrand seams". Read it before resolving anything.

A merge can break Kinako in two ways, and only the first is loud:

1. **Conflicts** where upstream edited a line the fork changed.
2. **Silent regressions** where upstream adds a new `t3code://` link, `~/.t3` path, `t3` executable name, `com.t3tools.t3code` ID or 3773 port in code the fork never touched. Git merges these cleanly, and the next build collides with an installed upstream T3 Code or sends links to the wrong app. Most of the work in this skill is catching these.

## Ground rules

- Merge, never rebase. `main` is published and other clones track it (FORK.md "Syncing with upstream").
- Do not push. Leave the merge commit local and report; the developer pushes after reviewing.
- The checkout may be shared with other sessions. Check `git status` and `git branch --show-current` right before merging and again before committing, and stop if either changed under you.
- Use `pnpm`, never `npm`/`npx`/`yarn`; run project tools with `pnpm exec` (for example `pnpm exec vp test run`, `pnpm exec tsc-rs --noEmit`).
- Redirect long test, typecheck and install output to a file in the scratchpad and grep that file, instead of piping it straight into `grep` or `head`.

## 1. Preflight

```bash
git status --short                 # must be clean
git checkout main && git pull --ff-only
git fetch upstream                 # remote: https://github.com/pingdotgg/t3code.git
.agents/skills/merge-upstream/scripts/scan-upstream.sh > /tmp/kinako-scan.txt   # or your scratchpad
```

Read the scan before merging. It has three sections:

1. **Seam files changed upstream.** Expect conflicts here. Read upstream's change to each one (`git diff $(git merge-base HEAD upstream/main) upstream/main -- <file>`), so you know what upstream meant before you are in the middle of a conflict.
2. **Workflows added upstream.** Each one needs disabling in the fork's Actions tab (FORK.md "One-time setup"). Report them; do not disable them yourself.
3. **Upstream identity literals on added lines.** Candidates for the post-merge sweep (step 4). Many are harmless labels; decide per line.

If the scan reports 0 commits, say so and stop.

## 2. Merge

```bash
git merge upstream/main -m "chore(fork): merge upstream main"
```

## 3. Resolve conflicts

Resolve each conflicted file by intent, not by picking a side wholesale. The general rule: **keep upstream's change, and keep the fork's identity on the lines that carry it.** For every hunk, ask what upstream wanted (new feature, refactor, rename) and what the fork's side is protecting (an import from `forkBrand`, a Kinako literal, a coexistence behavior). Then write the version that does both.

Known cases:

| Conflict                                                                                       | Resolution                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm-lock.yaml`                                                                               | `git checkout --theirs pnpm-lock.yaml`, then `pnpm install` once all other conflicts are resolved. Never hand-merge it.                                                                                                                                                                                                                                                                             |
| `.github/workflows/ci.yml`                                                                     | Take theirs, then rerun the runner substitution in FORK.md "CI".                                                                                                                                                                                                                                                                                                                                    |
| `README.md`                                                                                    | Keep ours, then port anything that still applies (new providers, docs links).                                                                                                                                                                                                                                                                                                                       |
| `apps/server/package.json`                                                                     | Take upstream's version and dependency lines; keep the `bin` key `"kinako"`. `name` stays `"t3"`.                                                                                                                                                                                                                                                                                                   |
| `apps/desktop/package.json`                                                                    | Take upstream's changes; keep `productName` as Kinako with upstream's stage label (`"Kinako (Beta)"`).                                                                                                                                                                                                                                                                                              |
| `apps/mobile/app.config.ts`                                                                    | Take upstream's plugins, permissions and settings; keep `VARIANT_CONFIG` names, schemes and bundle IDs, `appleTeamId: "6456AUQBLS"`, `slug: "kinako"`, `owner: "niranjan94"`, the EAS `projectId` and `updates.url` (`7f2d71e3-…`), and the `FORK_*` imports. If upstream adds Clerk `associatedDomains`/`relyingParty` back, leave them out. Use `FORK_DISPLAY_NAME` in any new permission string. |
| `apps/mobile/eas.json`                                                                         | Take upstream's build profiles; do not reintroduce upstream's `ascAppId`.                                                                                                                                                                                                                                                                                                                           |
| `scripts/build-desktop-artifact.ts`                                                            | Busy upstream file. Keep `DESKTOP_APP_ID = FORK_DESKTOP_APP_ID`, `FORK_DESKTOP_NAME` for `executableName`, `StartupWMClass` and the staged `name`, `FORK_URL_SCHEME`/`FORK_DEV_URL_SCHEME` in both protocol lists, the `Kinako-…` `artifactName`, the metainfo path, and the fork's deb maintainer, homepage and author.                                                                            |
| `packages/shared/src/cliRelease.ts`, `packages/ssh/src/tunnel.ts`, `apps/desktop/src/wsl/*`    | Archive stems and executable paths must use `FORK_CLI_NAME`; remote and WSL paths use `$HOME/${FORK_HOME_DIR_NAME}`. A raw `t3` here breaks SSH installs, WSL and self-update.                                                                                                                                                                                                                      |
| `apps/server/src/git/GitManager.ts`                                                            | Keep the `isManagedWorktree` guard in `reuseExistingWorktree` and the `${FORK_CLI_NAME}/pr-` branch prefix. If upstream reshapes the reuse paths, re-apply the guard so a worktree outside this environment's worktree roots is refused.                                                                                                                                                            |
| `apps/desktop/src/app/DesktopUserData.ts`, `apps/desktop/src/app/DesktopLegacyLocalStorage.ts` | Kinako never imports state from upstream T3 Code. Keep `resolveUserDataPath` a plain path join with no Windows `Local State` copy, and `V1_PROFILE_NAMES` empty, whatever upstream adds to its own migration.                                                                                                                                                                                       |
| `.github/triage/PLAYBOOK.md`, `apps/server/src/cli/triagePrompt.ts`                            | Take upstream's playbook changes, then reapply the fork's repository (`niranjan94/kinako`) for the playbook fetch, the source clone, the issue search and new-issue URL, plus the Kinako intro paragraph and `kinako serve`. Edit both files identically; `triagePrompt.test.ts` fails if they drift.                                                                                               |
| Import blocks                                                                                  | Keep both sides' imports. A dropped `FORK_*` import shows up as a typecheck error, not a conflict.                                                                                                                                                                                                                                                                                                  |
| A whole fork-edited file deleted or moved upstream                                             | Follow upstream, then re-apply the fork's edit in the new location. `git log --follow` and the scan help find it.                                                                                                                                                                                                                                                                                   |
| Test files                                                                                     | Take upstream's new and changed tests, then update their fixtures to Kinako values (`kinako://`, `.kinako`, `kinako` executables, 3873, `io.niranjan.kinako`, `Kinako (Nightly)`) wherever they assert fork-owned behavior. Leave fixtures that are arbitrary labels alone.                                                                                                                         |

If a conflict is a real product decision rather than a mechanical one (upstream redesigns something the fork deliberately diverged on, such as telemetry, pairing origins or the release flow), stop and ask instead of guessing.

## 4. Post-merge sweep

After the conflicts are resolved and before committing, go through section 3 of the scan. For each line, decide:

- **Identity that must change.** A scheme the OS routes on, a path under the user's home or XDG dirs, an executable or archive name, an app, bundle or launchd ID, a systemd unit or slice, a default port, a D-Bus name, a GNOME extension UUID, a PR branch prefix, mobile EAS/Apple/Clerk values, the client name sent to a provider's backend (Codex `CODEX_CLIENT_NAME` and the ChatGPT sign-in `agent_name_hint`). Import the matching constant from `@t3tools/shared/forkBrand` (or `./forkBrand.ts` inside `packages/shared`). If upstream introduced a new identity concept with no constant, add one to `forkBrand.ts`, named and documented like its neighbors.
- **Files that cannot import** (the shell installers, `electron-launcher.mjs`, `compileCache.ts`, the GNOME extension, the iOS widget, `packages/contracts`): write the Kinako literal.
- **Harmless labels.** User-agent strings, OTel service names, MCP server aliases, OAuth referrers, test fixture names, prose and docs: leave as upstream wrote them. User-facing "T3 Code" UI strings stay too, unless they are among the names users see first (window titles, installers, OS permission prompts, the sidebar brand).

Then grep the merged tree once for anything the scan's patterns missed, limited to files the merge touched:

```bash
git diff --name-only --diff-filter=d HEAD -- . ':!pnpm-lock.yaml' | xargs rg -n 't3code(-dev|-preview)?://|com\.t3tools\.t3code|~/\.t3\b|\$HOME/\.t3\b|\b3773\b|t3code\.service|snap-shot@t3\.codes'
```

## 5. Verify

Run only what covers the change (AGENTS.md "Verifying"); CI runs the full suite after the push.

- If the lockfile changed: `pnpm install`.
- Typecheck every package with a conflicted or swept file: `cd <package> && pnpm exec tsc-rs --noEmit`.
- Run the tests next to every conflicted or swept file, plus the identity tests that guard the seams when their source changed: `scripts/build-desktop-artifact.test.ts`, `scripts/dev-runner.test.ts`, `packages/shared/src/cliRelease.test.ts`, `packages/ssh/src/tunnel.test.ts`, `apps/desktop/src/wsl/DesktopWslEnvironment.test.ts`, `apps/server/src/cloud/bootService.test.ts`, `apps/server/src/git/GitManager.test.ts`. Run them from the package directory with `pnpm exec vp test run <files>`; from `scripts/`, add `--config ../vite.config.ts`.
- `apps/server/src/process/externalLauncher.test.ts` fails on some machines because it depends on the VS Code builds installed there. Check it against `main` before blaming the merge.

## 6. Commit and report

Commit the resolution as the merge commit (`git commit --no-edit` keeps `chore(fork): merge upstream main`). If the sweep found new seams, update FORK.md's "Rebrand seams" list in the same commit or a follow-up `docs(fork): …` commit, so the next merge knows about them.

Report:

- How many upstream commits came in.
- Each conflicted file and how it was resolved, in a sentence each.
- Each upstream literal changed to a Kinako value, and any left alone on purpose that a reviewer might question.
- New workflows to disable.
- Tests and typechecks run, with results; anything that failed and why.
- Anything that needs a human decision.

Then stop. Pushing is the developer's call.
