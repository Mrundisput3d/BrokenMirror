#!/usr/bin/env bash
# Wrapper so systemd/cron can run the scraper with nvm-installed node.
# nvm puts node on PATH only in interactive shells, so we source nvm here
# and then call node. Run from anywhere; it cd's to its own directory.
set -euo pipefail

# Load nvm (adjust NVM_DIR if you installed nvm elsewhere).
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Run from the repo directory regardless of where we were invoked.
cd "$(dirname "$(readlink -f "$0")")"

exec node scrape-regroups.js --push --key serviceAccount.json
