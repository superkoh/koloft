#!/usr/bin/env bash
# Assert the atlas-fixed @xterm/addon-webgl (0.20.0-beta.298+) is present in a built
# artifact.
#
# an earlier release shipped an atlas-corrupting addon: the release was built in a checkout whose
# node_modules held the wrong addon, and nothing in the release chain checked what
# actually got bundled. The live version of that trap: a worktree with no node_modules
# of its own silently resolves the parent checkout's — which may still hold the
# pre-fix 0.19.0 addon — so vite bundles the garbled-screen bugs right back in. This checks the
# ARTIFACT: `_lastSeenPageLayoutVersion` is a property name from the addon's
# per-renderer atlas-page invalidation (the upstream fix for the corruption class),
# absent from every pre-fix addon; esbuild minification preserves property names, so
# it survives into the renderer bundle and the asar. webglAtlasFix.test.ts pins the
# same string against the installed addon, so an upstream rename fails at unit time.
#
# Usage: assert-webgl-atlas.sh <file-or-dir>...
#   dir    → at least one file under it must contain the fingerprint
#   .asar  → an out/renderer/**.js INSIDE the archive must contain it. Never raw-grep
#            an asar: the packaging glob also sweeps in test/ sources, whose
#            fingerprint mentions would make a stale asar look healthy.
#   file   → the file itself must contain it
set -euo pipefail

FINGERPRINT='_lastSeenPageLayoutVersion'

[ "$#" -gt 0 ] || {
  echo "usage: $0 <file-or-dir>..." >&2
  exit 2
}

check_asar() {
  node -e '
    const asar = require("@electron/asar")
    const [archive, fingerprint] = process.argv.slice(1)
    const renderer = asar
      .listPackage(archive)
      .map((f) => f.replace(/\\/g, "/").replace(/^\//, ""))
      .filter((f) => /^out\/renderer\/.*\.js$/.test(f))
    if (renderer.length === 0) {
      console.error("assert-webgl-atlas: no out/renderer JS inside " + archive)
      process.exit(1)
    }
    const hit = renderer.some((f) => asar.extractFile(archive, f).includes(fingerprint))
    process.exit(hit ? 0 : 1)
  ' "$1" "$FINGERPRINT"
}

for target in "$@"; do
  if [ -d "$target" ]; then
    hit="$(grep -rla "$FINGERPRINT" "$target" | head -1 || true)"
  elif [ -f "$target" ]; then
    case "$target" in
      *.asar) hit="$(check_asar "$target" && echo "$target" || true)" ;;
      *) hit="$(grep -la "$FINGERPRINT" "$target" || true)" ;;
    esac
  else
    echo "assert-webgl-atlas: error: no such file or directory: $target" >&2
    exit 1
  fi
  if [ -z "$hit" ]; then
    {
      echo "assert-webgl-atlas: FAIL: '$FINGERPRINT' not found in $target"
      echo "This artifact was bundled from a PRE-FIX @xterm/addon-webgl — shipping it"
      echo "regresses the WebGL garbled-screen fixes (atlas page merge/invalidation, upstream"
      echo "0.20.0-beta.298+). Likely cause: a stale or parent-checkout node_modules."
      echo "Fix: run 'npm install' in THIS checkout, then rebuild."
    } >&2
    exit 1
  fi
done
echo "assert-webgl-atlas: OK ($*)"
