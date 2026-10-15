#!/bin/zsh
set -eu
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd -- "$(dirname -- "$0")/.."
if ! command -v node >/dev/null 2>&1; then
  print "Node.js is needed to run this local demo. Open it from the configured development terminal."
  read -r "?Press Return to close."
  exit 1
fi
npm run demo:focused
