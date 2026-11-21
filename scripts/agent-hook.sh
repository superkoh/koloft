#!/bin/sh
PATH="$HOME/.koloft/node/bin:$PATH:/opt/homebrew/bin:/usr/local/bin"
command -v node >/dev/null 2>&1 || exit 0
exec node "$(dirname "$0")/agent-hook.mjs" "$@"
