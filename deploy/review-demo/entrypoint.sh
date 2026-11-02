#!/bin/sh
set -eu

settings="$T3CODE_HOME/userdata/settings.json"
if [ ! -f "$settings" ]; then
  mkdir -p "$(dirname "$settings")"
  cp /opt/replay/settings.json "$settings"
fi

project=/workspace/demo
if [ ! -d "$project/.git" ]; then
  mkdir -p "$project"
  cd "$project"
  git init -q -b main
  git config user.name "Kinako Demo"
  git config user.email "demo@localhost"
  printf '# Demo project\n\nA sample project for trying Kinako.\n' > README.md
  git add README.md
  git commit -q -m "Initial commit"
fi

# `serve` is headless and never bootstraps a project, so the reviewer would start with none.
exec kinako start \
  --no-browser \
  --host 0.0.0.0 \
  --port 3873 \
  --base-dir "$T3CODE_HOME" \
  --auto-bootstrap-project-from-cwd \
  "$project"
