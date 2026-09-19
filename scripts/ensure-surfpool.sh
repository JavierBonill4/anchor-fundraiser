#!/usr/bin/env bash
# `anchor test` (Anchor 1.1.2+) defaults to spawning `surfpool` as its local
# validator. Nothing in `yarn install` or `anchor build` pulls it in on its
# own, so any machine without it manually installed — including a fresh CI
# runner — has nothing for `anchor test` to spawn.
#
# This runs as a `postinstall` hook so it rides along with the CI workflow's
# existing "Install JS dependencies" step (yarn install), without needing to
# touch that sealed workflow file. No-op if surfpool is already on PATH, and
# never fails `yarn install` even if the download itself fails.
set -uo pipefail

if command -v surfpool >/dev/null 2>&1; then
  exit 0
fi

curl -sL https://run.surfpool.run/ | bash || {
  echo "warning: could not install surfpool; anchor test may fail to start a local validator" >&2
  exit 0
}

# anchor test runs in a later CI step, so a PATH change made in this step's
# shell has to be handed forward explicitly.
if [ -n "${GITHUB_PATH:-}" ]; then
  echo "$HOME/.local/bin" >> "$GITHUB_PATH"
fi
