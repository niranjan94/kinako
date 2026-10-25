#!/bin/sh
# Lists what an upstream merge brings in that touches Kinako's identity.
#
#   scan-upstream.sh [upstream-ref] [fork-ref]
#   scan-upstream.sh --drift [fork-ref]
#
# Defaults: upstream/main and HEAD. Before merging, run it as is. After a merge
# commit exists, pass the two parents: scan-upstream.sh HEAD^2 HEAD^1.
#
# Sections:
#   1. Fork seam files upstream changed (expect conflicts or silent reverts).
#   2. New upstream workflows (disable them in the fork's Actions tab).
#   3. New upstream migrations, which must be renumbered after the fork's.
#   4. Lines upstream added that carry an upstream identity literal. Each one
#      is a candidate for a forkBrand import; some are labels that stay.
#
# --drift runs after conflicts are resolved: it lists files whose code (not comments)
# lost FORK_* references or Kinako literals compared with the fork (default HEAD,
# which is the fork's side during a merge). A drop is a silent revert unless
# upstream deleted that code on purpose.
set -eu

if [ "${1:-}" = "--drift" ]; then
  fork="${2:-HEAD}"
  identity='FORK_[A-Z_]+|[Kk]inako'
  # Comment lines are skipped: upstream rewording a comment that named Kinako is not a revert.
  count() { grep -IvE '^[[:space:]]*(//|/?\*|#)' | grep -oE "$identity" | wc -l; }
  printf '== Identity drift against %s\n\n' "$fork"
  found=0
  for file in $(git diff --name-only --diff-filter=M "$fork" -- . ':(exclude)pnpm-lock.yaml'); do
    before="$(git show "$fork:$file" | count)"
    after="$(count < "$file" 2>/dev/null || echo 0)"
    if [ "$after" -lt "$before" ]; then
      printf '%s  %s -> %s\n' "$file" "$before" "$after"
      found=1
    fi
  done
  [ "$found" = 1 ] || printf '(none)\n'
  exit 0
fi

upstream="${1:-upstream/main}"
fork="${2:-HEAD}"
base="$(git merge-base "$fork" "$upstream")"

printf '== %s commits from %s not in %s (merge-base %s)\n\n' \
  "$(git rev-list --count "$base..$upstream")" "$upstream" "$fork" "$(git rev-parse --short "$base")"

# Files the fork routes through forkBrand, plus files that repeat its values
# because they cannot import TypeScript (FORK.md "Rebrand seams").
seam_files="$(
  {
    git grep -l -e '@t3tools/shared/forkBrand' -e '\./forkBrand\.ts' -e 'forkBrand\.ts"' "$fork" -- . \
      | sed "s|^$fork:||"
    printf '%s\n' \
      scripts/install.sh scripts/install.ps1 .github/triage/PLAYBOOK.md \
      apps/desktop/scripts/electron-launcher.mjs apps/desktop/src/compileCache.ts \
      apps/desktop/package.json apps/desktop/resources/linux/io.niranjan.kinako.metainfo.xml \
      apps/desktop/gnome-extension/metadata.json apps/desktop/gnome-extension/bundle.json \
      apps/desktop/gnome-extension/extension.js apps/desktop/gnome-extension/captureService.js \
      apps/desktop/src/app/DesktopLegacyLocalStorage.ts apps/desktop/src/app/DesktopUserData.ts \
      apps/desktop/src/snapShot/KdeSnapShot.ts apps/desktop/src/snapShot/HyprlandSnapShot.ts \
      apps/desktop/src/snapShot/GnomeCaptureSetup.ts apps/desktop/src/snapShot/linuxCaptureSession.ts \
      apps/desktop/src/snapShot/captureConfigEdit.ts \
      apps/mobile/app.config.ts apps/mobile/eas.json apps/mobile/package.json \
      apps/mobile/src/widgets/AgentActivity.tsx \
      packages/contracts/src/settings.ts apps/server/package.json apps/server/src/serviceLauncher.ts \
      .github/workflows/fork-release.yml .github/workflows/release-desktop.yml \
      .github/workflows/mobile-android-apk.yml .github/workflows/ci.yml \
      .devcontainer/devcontainer.json scripts/mobile-native-client.ts scripts/mobile-showcase.ts \
      AGENTS.md README.md FORK.md
  } | sort -u
)"

printf '== 1. Seam files changed upstream\n\n'
seam_list="$(mktemp)"
trap 'rm -f "$seam_list"' EXIT
printf '%s\n' "$seam_files" > "$seam_list"
git diff --name-only "$base" "$upstream" | grep -Fxf "$seam_list" || printf '(none)\n'
printf '\n'

printf '== 2. Workflows added upstream\n\n'
git diff --name-only --diff-filter=A "$base" "$upstream" -- .github/workflows || true
printf '\n'

printf '== 3. Migrations added upstream\n\n'
migrations="$(git diff --name-only --diff-filter=A "$base" "$upstream" -- apps/server/src/persistence/Migrations \
  | grep -E '/[0-9]{3}_[^/]+\.ts$' | grep -v '\.test\.ts$' || true)"
if [ -z "$migrations" ]; then
  printf '(none)\n'
else
  last="$(git show "$fork:apps/server/src/persistence/Migrations.ts" \
    | grep -oE '^  \[[0-9]+,' | tr -dc '0-9\n' | sort -n | tail -1)"
  printf 'Fork migrations end at %s. Renumber each upstream migration after it, in order,\n' "$last"
  printf 'renaming the file and its test and updating Migrations.ts and reconcileV2PreviewMigration.test.ts:\n'
  next=$((last + 1))
  for file in $migrations; do
    printf '  %s -> %03d\n' "$file" "$next"
    next=$((next + 1))
  done
fi
printf '\n'

printf '== 4. Upstream identity literals on added lines\n\n'
# label<TAB>extended regex. Kept broad on purpose: a false positive costs one
# glance, a miss ships a build that collides with upstream T3 Code.
patterns='scheme	t3code(-dev|-preview)?(://|:")|"t3code(-dev|-preview)?"
home-dir	~/\.t3([^a-z0-9]|$)|\$HOME/\.t3([^a-z0-9]|$)|["'"'"'/]\.t3(["'"'"'/]|$)
app-id	com\.t3tools\.(t3code|T3Code)
cli-exe	t3\.(exe|cmd)|["'"'"'/]t3["'"'"'`]|t3-\$\{?[a-zA-Z_]*[vV]ersion|lib/node_modules/t3
desktop	t3code-v2|"t3code-dev"|T3-Code-\$|executableName|StartupWMClass|dataHome, *"t3code"
service	t3code\.service|app-t3code-agents|`t3code-\$\{
port	(^|[^0-9])(3773|13773|5733)([^0-9]|$)|--https=443|SERVE_PORT = 443
snapshot	snap-shot@t3\.codes|T3SnapShot|Ctrl\+Shift\+2|CTRL( \+)? SHIFT,? (\+ )?2|both-shift-keys
pr-branch	t3code/pr-
wt-branch	["'"'"'`]t3/[a-z0-9][a-z0-9-]*["'"'"'`]
mobile	clerk\.t3\.codes|ARK85ZXQ4Z|pingdotgg"|d763fcb8|6787819824|t3-code"
display	productName|appName:|"T3 Code \((Alpha|Nightly|Dev)\)"'

git diff -U0 "$base" "$upstream" -- . ':(exclude)pnpm-lock.yaml' ':(exclude).repos' ':(exclude)apps/marketing' \
  | PATTERNS="$patterns" awk '
    BEGIN {
      n = split(ENVIRON["PATTERNS"], rows, "\n")
      for (i = 1; i <= n; i++) { split(rows[i], kv, "\t"); label[i] = kv[1]; re[i] = kv[2] }
    }
    /^\+\+\+ b\// { file = substr($0, 7); next }
    /^@@/ {
      split($3, hunk, ","); line = substr(hunk[1], 2) + 0; next
    }
    /^\+/ {
      text = substr($0, 2)
      for (i = 1; i <= n; i++) {
        if (text ~ re[i]) {
          sub(/^[ \t]+/, "", text)
          if (length(text) > 160) text = substr(text, 1, 157) "..."
          printf "%-9s %s:%d  %s\n", label[i], file, line, text
          found = 1
          break
        }
      }
      line++
    }
    END { if (!found) print "(none)" }
  '
