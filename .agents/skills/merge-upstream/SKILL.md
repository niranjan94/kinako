---
name: merge-upstream
description: Merge pingdotgg/t3code's main into this Kinako fork and resolve the conflicts the rebrand causes, keeping Kinako installable next to upstream T3 Code. Use whenever asked to sync with upstream, pull in upstream changes, merge upstream/main, catch up with T3 Code, or resolve conflicts from an upstream merge, even if the request does not mention Kinako or the rebrand.
---

# Merge upstream into Kinako

This repository is a fork of `pingdotgg/t3code` that ships as **Kinako**. Its identity (display name, `~/.kinako`, the `kinako` CLI and release archives, `io.niranjan.kinako` app IDs, `kinako://` schemes, service names, default ports 3873 and 8443, SnapShot helper names, `kinako/<hex>` worktree branches) is routed through `packages/shared/src/forkBrand.ts`. FORK.md has the full list under "Rebrand seams". Read it before resolving anything.

A merge can break Kinako in three ways, and only the first is loud:

1. **Conflicts** where upstream edited a line the fork changed.
2. **Silent regressions** where upstream adds a new `t3code://` link, `~/.t3` path, `t3` executable name, `com.t3tools.t3code` ID or 3773 port in code the fork never touched. Git merges these cleanly, and the next build collides with an installed upstream T3 Code or sends links to the wrong app.
3. **Silent reverts** where a clean merge or a careless resolution drops a `FORK_*` reference the fork had.

Merge often. Conflict count grows with the gap, not with upstream's activity: a week of upstream is a dozen conflicts, a month is a hundred.

## Ground rules

- Merge, never rebase. `main` is published and other clones track it (FORK.md "Syncing with upstream").
- Leave the merge commit local and report; the developer pushes after reviewing. If the developer asks you to push, the merge is not done until CI is green on the pushed commit (step 8).
- The checkout may be shared with other sessions. Check `git status` and `git branch --show-current` right before merging and again before committing, and stop if either changed under you.
- Use `pnpm`; run project tools with `pnpm exec` or from `node_modules/.bin`.
- Write long test, typecheck and install output to a file in the scratchpad (`$S` below) and grep that file.
- Inside a Kinako session the shell inherits the live service's environment (`T3_SERVICE_LAUNCHER_CONTEXT`, `T3CODE_HOME=~/.kinako`, `T3CODE_PORT`, `T3CODE_HOST`, `T3CODE_NO_BROWSER`). Run every test command under `env -u` for all five, so tests neither fail on a launcher mismatch nor resolve the live home.
- In zsh, `for f in $list` does not split words. Loop over a file with `while read -r f; do …; done < list.txt`.

## 1. Preflight

```bash
git status --short                 # must be clean
git checkout main && git pull --ff-only
git fetch upstream                 # remote: https://github.com/pingdotgg/t3code.git
.agents/skills/merge-upstream/scripts/scan-upstream.sh > "$S/scan.txt"
```

The scan has four sections:

1. **Seam files changed upstream.** Usually long, since most seam files carry fork edits. Skim it for files you recognise from the known cases below; step 5's drift check is what catches reverts.
2. **Workflows added upstream.** Each needs disabling in the fork's Actions tab (FORK.md "One-time setup"). Report them; the developer disables them.
3. **Migrations added upstream**, flagged where they touch a table a fork migration alters (step 3).
4. **Upstream identity literals on added lines.** Input for step 5.

If the scan reports 0 commits, say so and stop. Done when you have read sections 2 to 4.

## 2. Merge and triage

```bash
git merge upstream/main -m "chore(fork): merge upstream main"
node .agents/skills/merge-upstream/scripts/classify-conflicts.ts --apply > "$S/triage.txt"
```

Run the classifier before anyone edits a conflicted file. It rebuilds each conflict from the index stages and resolves the hunks a rule settles: one side changed only comments (the other side's code is kept, and comment edits are carried over where the code under them is unchanged), or every line is an import (union, minus what upstream removed). Fully resolved files are staged; partly resolved files keep their remaining conflicts in diff3 form, with the base section. Then run `vp fmt` on every file the report marks `full` or `partial`.

The report groups the remaining files by tier (`opus`, `sonnet`, `haiku`) and lists modify/delete conflicts and the lockfile. Done when the classifier has run and `vp fmt` has formatted its files.

## 3. Resolve the rest

Resolve each remaining file by intent, not by picking a side wholesale. The general rule: **keep upstream's change, and keep the fork's identity and features on the lines that carry them.** For every hunk, ask what upstream wanted (new feature, refactor, rename) and what the fork's side is protecting (an import from `forkBrand`, a Kinako literal, a fork feature, a coexistence behaviour). Then write the version that does both. Where both sides added cases, entries or handlers next to each other, take both and check the seams between them: a `switch` union drops a `break` as easily as it keeps one.

With more than about 30 open files, delegate by tier: read [DELEGATION.md](DELEGATION.md) for the routing, the brief, and the coordination rules. Below that, resolve them yourself.

If a conflict is a real product decision rather than a mechanical one (upstream redesigns something the fork deliberately diverged on, such as telemetry, pairing origins or the release flow), stop and ask instead of guessing.

Done when `git diff --name-only --diff-filter=U` is empty and no file the merge touched contains a conflict marker.

### Known cases

| Conflict                                                                                       | Resolution                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm-lock.yaml`                                                                               | `git checkout --theirs pnpm-lock.yaml`, then `pnpm install` once all other conflicts are resolved. Never hand-merge it.                                                                                                                                                                                                                                                                             |
| Migrations (scan section 3)                                                                    | Upstream migrations keep upstream's ids and merge cleanly; never renumber them. Fork-only migrations live in `Migrations/fork/` with their own ledger (`ForkMigrations.ts`) and run after all of upstream's. For each flagged migration, check it does not rebuild or drop a table the fork alters; if it does, add a fork migration that restores the fork's column or index.                      |
| Deleted in the fork, changed upstream                                                          | Keep it deleted (`git rm`) unless the fork's reason no longer holds; `git log` on the fork side shows why it went.                                                                                                                                                                                                                                                                                  |
| Deleted or moved upstream, changed in the fork                                                 | Follow upstream, then re-home the fork's change in upstream's new structure. `git log $(git merge-base HEAD MERGE_HEAD)..HEAD -- <file>` shows which fork commits to carry. A change that was only a previous merge's adjustment needs nothing.                                                                                                                                                     |
| `.github/workflows/ci.yml`                                                                     | Take theirs, then rerun both substitutions in FORK.md "CI" (runners and the web test timeout).                                                                                                                                                                                                                                                                                                      |
| `README.md`                                                                                    | Keep ours, then port anything that still applies (new providers, docs links).                                                                                                                                                                                                                                                                                                                       |
| `apps/server/package.json`                                                                     | Take upstream's version and dependency lines; keep the `bin` key `"kinako"`. `name` stays `"t3"`.                                                                                                                                                                                                                                                                                                   |
| `apps/desktop/package.json`                                                                    | Take upstream's changes; keep `productName` as Kinako with upstream's stage label (`"Kinako (Beta)"`).                                                                                                                                                                                                                                                                                              |
| `apps/mobile/app.config.ts`                                                                    | Take upstream's plugins, permissions and settings; keep `VARIANT_CONFIG` names, schemes and bundle IDs, `appleTeamId: "6456AUQBLS"`, `slug: "kinako"`, `owner: "niranjan94"`, the EAS `projectId` and `updates.url` (`7f2d71e3-…`), and the `FORK_*` imports. If upstream adds Clerk `associatedDomains`/`relyingParty` back, leave them out. Use `FORK_DISPLAY_NAME` in any new permission string. |
| `apps/mobile/eas.json`                                                                         | Take upstream's build profiles; leave upstream's `ascAppId` out.                                                                                                                                                                                                                                                                                                                                    |
| `scripts/build-desktop-artifact.ts`                                                            | Busy upstream file. Keep `DESKTOP_APP_ID = FORK_DESKTOP_APP_ID`, `FORK_DESKTOP_NAME` for `executableName`, `StartupWMClass` and the staged `name`, `FORK_URL_SCHEME`/`FORK_DEV_URL_SCHEME` in both protocol lists, the `Kinako-…` `artifactName`, the metainfo path, and the fork's deb maintainer, homepage and author.                                                                            |
| `packages/shared/src/cliRelease.ts`, `packages/ssh/src/tunnel.ts`, `apps/desktop/src/wsl/*`    | Archive stems and executable paths must use `FORK_CLI_NAME`; remote and WSL paths use `$HOME/${FORK_HOME_DIR_NAME}`. A raw `t3` here breaks SSH installs, WSL and self-update.                                                                                                                                                                                                                      |
| `apps/server/scripts/cli.ts`, `apps/server/vite.config.ts`                                     | The single executable is `dist-exe/${FORK_CLI_NAME}`; `scripts/build-cli-archive.ts` looks for that name. Any new path that writes or names the built executable (such as the linux-arm64 SEA injection) uses `FORK_CLI_NAME`, not `t3`.                                                                                                                                                            |
| `apps/server/src/git/GitManager.ts`                                                            | Keep the `isManagedWorktree` guard in `reuseExistingWorktree` (and its `HostProcess` import) and the `${FORK_CLI_NAME}/pr-` branch prefix. If upstream reshapes the reuse paths, re-apply the guard so a worktree outside this environment's worktree roots is refused.                                                                                                                             |
| `apps/server/src/ws.ts`, `packages/contracts/src/rpc.ts`                                       | Take upstream's RPC list, handler object and `SPLIT_WS_RPC_PREFIXES` split as they are. Fork RPCs and handlers sit in one block at the end of `WsRpcGroup` and of `handlers`; keep them there. If typecheck reports `unknown` requirements after a merge, the groups crossed the compiler limit again: add a prefix to `SPLIT_WS_RPC_PREFIXES`.                                                     |
| `apps/server/src/mcp/toolkits/*`, `apps/server/src/provider/agentContextBudget.json`           | Fork-only MCP tools live in `toolkits/fork/`; take upstream's other toolkits as they are. Take upstream's `agentContextBudget.json` as is. `agentContextBudget.fork.json` holds the bytes the fork's tools add; if the budget test fails after a merge, upstream changed a tool the fork edits, so update the fork file by the difference.                                                          |
| `apps/desktop/src/app/DesktopUserData.ts`, `apps/desktop/src/app/DesktopLegacyLocalStorage.ts` | Kinako never imports state from upstream T3 Code. Keep `resolveUserDataPath` a plain path join with no Windows `Local State` copy, and `V1_PROFILE_NAMES` empty, whatever upstream adds to its own migration.                                                                                                                                                                                       |
| `.github/triage/PLAYBOOK.md`, `apps/server/src/cli/triagePrompt.ts`                            | Take upstream's playbook changes, then reapply the fork's repository (`niranjan94/kinako`) for the playbook fetch, the source clone, the issue search and new-issue URL, plus the Kinako intro paragraph and `kinako serve`. Edit both files identically; `triagePrompt.test.ts` fails if they drift.                                                                                               |
| `scripts/mobile-native-client.ts`, `scripts/mobile-e2e.ts`                                     | Keep the `io.niranjan.kinako.dev` bundle ID, `KinakoDev` workspace, scheme and `.app` names, `FORK_DEV_URL_SCHEME`, and `.cache/${FORK_CLI_NAME}/…` cache paths, so a Kinako checkout never evicts or overwrites an upstream checkout's cached clients and device records.                                                                                                                          |
| `scripts/effect-budget.json`                                                                   | Take upstream's counts for its files and keep the fork's entries. If `t3code/react-effect-budget` flags a fork effect that predates the merge, record its current count here; an effect the fork adds later states its reason instead.                                                                                                                                                              |
| Comments                                                                                       | Take upstream's wording, with Kinako names wherever the comment names a command, path or archive. Comment blocks are capped at four lines by `t3code/no-low-value-comments`.                                                                                                                                                                                                                        |
| Test files                                                                                     | Take upstream's new and changed tests, then update their fixtures to Kinako values (`kinako://`, `.kinako`, `kinako` executables, 3873, `io.niranjan.kinako`, `Kinako (Nightly)`, `WORKTREE_BRANCH_PREFIX` for `t3/<branch>`) wherever they assert fork-owned behaviour. Leave fixtures that are arbitrary labels, such as a port passed as an argument.                                            |

## 4. Install and fix compile errors

```bash
pnpm install > "$S/install.log" 2>&1
```

Typecheck every package that had a conflicted, deleted or swept file. A clean merge still breaks fork code that calls something upstream renamed or moved, so expect errors in fork-only files next to the conflicts. Use the tsc-rs binary directly; package `node_modules/.bin/tsc` shims can point at a removed TypeScript after a dependency change:

```bash
TSC="$PWD/node_modules/.pnpm/@tsc-rs+typescript@$(node -p 'require("./node_modules/@tsc-rs/typescript/package.json").version')/node_modules/@tsc-rs/typescript/bin/tsc"
(cd <package> && node "$TSC" --noEmit > "$S/tc-<package>.log" 2>&1)
```

Done when every affected package typechecks with zero errors.

## 5. Sweep for regressions and reverts

Go through section 4 of the scan. For each line, decide:

- **Identity that must change.** A scheme the OS routes on, a path under the user's home or XDG dirs, an executable or archive name, an app, bundle or launchd ID, a systemd unit or slice, a default port, a D-Bus name, a GNOME extension UUID, a PR or worktree branch prefix, mobile EAS/Apple/Clerk values, the client name sent to a provider's backend (Codex `CODEX_CLIENT_NAME` and the ChatGPT sign-in `agent_name_hint`). Import the matching constant from `@t3tools/shared/forkBrand` (or `./forkBrand.ts` inside `packages/shared`). If upstream introduced a new identity concept with no constant, add one to `forkBrand.ts`, named and documented like its neighbours.
- **Files that cannot import** (FORK.md's list, plus any new script in another language): write the Kinako literal, and add the file to that list.
- **Harmless labels.** User-agent strings, OTel service names, MCP server aliases, OAuth referrers, arbitrary test fixture values, prose and docs: leave as upstream wrote them. User-facing "T3 Code" UI strings stay too, unless they are among the names users see first (window titles, installers, OS permission prompts, the sidebar brand).

Then catch what the scan's patterns and the resolutions missed:

```bash
git diff --cached -U0 HEAD -- . ':!pnpm-lock.yaml' | grep -E '^\+[^+]' \
  | grep -nE 't3code(-dev|-preview)?://|com\.t3tools\.t3code|~/\.t3\b|\$HOME/\.t3\b|\b3773\b|t3code\.service|snap-shot@t3\.codes'
.agents/skills/merge-upstream/scripts/scan-upstream.sh --drift > "$S/drift.txt"
```

The first command looks only at lines the merge added. `--drift` lists files whose code lost `FORK_*` references or Kinako literals against the fork's side; each entry is a revert unless upstream deleted that code on purpose.

Done when every section 4 line, every added-line hit and every drift entry has a decision.

## 6. Verify with CI's scope

A merge changes behaviour under files it never touched: a new upstream lint rule applies to fork-only files, and an upstream semantics change breaks fork tests that sit beside unchanged code. `check:changed` only looks at changed files, so a merge runs what CI runs, repo-wide. This is the developer's standing exception to AGENTS.md's "no repo-wide checks" for upstream merges.

```bash
export PATH="$PWD/node_modules/.bin:$PATH"
clean=(env -u T3_SERVICE_LAUNCHER_CONTEXT -u T3CODE_HOME -u T3CODE_PORT -u T3CODE_HOST -u T3CODE_NO_BROWSER PATH="$PATH")
vp fmt --check > "$S/fmt.log" 2>&1; echo "fmt=$?"
vp lint > "$S/lint.log" 2>&1; echo "lint=$?"
vp run knip:check > "$S/knip.log" 2>&1; echo "knip=$?"
"${clean[@]}" vp run --parallel --concurrency-limit 4 --filter '!t3' --filter '!@t3tools/monorepo' --filter '!@t3tools/web' test > "$S/test-packages.log" 2>&1; echo "packages=$?"
"${clean[@]}" vp run --filter @t3tools/web test > "$S/test-web.log" 2>&1; echo "web=$?"
"${clean[@]}" vp run --filter t3 test > "$S/test-server.log" 2>&1; echo "server=$?"
```

These mirror CI's Lint, Test, Test web and Test server jobs (`.github/workflows/ci.yml`); if CI's commands change, follow them. Run them in the background where you can; the server suite is the long one. Typecheck is step 4's job, since `vp check` typechecks through the package shims. `clean` is an array because zsh does not word-split a string variable; an exit code of 127 means the suite never ran.

`vp run` stops launching packages after the first failure, so a single known failure hides every package that had not started yet. Check the `vp run: N/M successful` line: every one of the M tasks must have printed a `Test Files` summary. If a known machine failure (below) stopped the run, rerun with that package excluded (for example `--filter '!./apps/desktop'`) until all the others report.

- Lint errors (`grep -E "Found [0-9]+ error|  × " "$S/lint.log"`) on comments are the four-line cap: shorten the comment, keeping the constraint. Warnings are not failures.
- A fork test that fails beside unchanged code usually means upstream changed the behaviour or data shape under it. Read the upstream commit that changed the code under test, then update the fixture if the fork's behaviour still holds in practice, or fix the fork code if it does not.
- For each other failing test, rerun its file alone. If it still fails, run it on pre-merge `main` in a temporary sibling worktree (`git worktree add --detach ../kinako-premerge HEAD^1`, `pnpm install`, run, `git worktree remove --force`) before blaming the merge. These fail on some machines regardless of the merge: `apps/server/src/process/externalLauncher.test.ts` (depends on installed VS Code builds), `apps/server/src/cloud/pinnedRuntime.test.ts` "keeps a runtime a process runs through a symlink", `apps/server/src/provider/acp/AcpSessionRuntime.processTree.test.ts` "preserves exact argv…", and `apps/desktop/scripts/browser-secret-native.test.mjs` (needs `libsecret-1-dev` and `pkg-config`, which CI installs).

Done when format, lint and knip pass and every remaining test failure is shown to fail on pre-merge `main` too. Any edit after this point reruns the affected command before committing.

## 7. Commit and report

Check `git status` and the branch again, then commit the resolution as the merge commit (`git commit --no-edit` keeps `chore(fork): merge upstream main`). If the sweep found new seams, update FORK.md's "Rebrand seams" list and this skill's known cases in the same commit, so the next merge knows about them.

Report:

- How many upstream commits came in, how many files conflicted, and how many hunks the classifier resolved.
- Each conflicted file that needed judgement and how it was resolved, in a sentence each.
- Each upstream literal changed to a Kinako value, and any left alone on purpose that a reviewer might question.
- Each upstream migration that touches a fork-altered table, and whether it needed a fork migration.
- New workflows to disable.
- Tests and typechecks run, with results; anything that failed and why.
- Anything that needs a human decision.

Then stop. Pushing is the developer's call.

## 8. After a push to main

Only when the developer asked you to push. Push with `git push origin HEAD:main` (a fast-forward; never force), then wait for the `CI` run on that exact commit to finish:

```bash
sha=$(git rev-parse HEAD)
run=$(gh run list -R niranjan94/kinako --branch main --workflow CI --commit "$sha" --json databaseId --jq '.[0].databaseId')
gh run watch "$run" -R niranjan94/kinako --exit-status > "$S/ci-watch.log" 2>&1; echo "ci=$?"
```

The run can take a few seconds to appear after the push. Run the watch in the background; it takes as long as the server shards.

- Green: report the run as passed. Only now is `main` ready for **Fork release** (FORK.md "Releasing"), and only if the developer asked for one.
- Red: `gh run view "$run" -R niranjan94/kinako --log-failed > "$S/ci-fail.log"`, find the failing test, reproduce it locally, fix it, rerun its package's full suite, push the fix as its own conventional commit, and watch CI again. Never start a release or report the merge as done on a red `main`.
