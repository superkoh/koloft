#!/bin/sh
mkdir -p /tmp/out
node /probe/fake-gemini.mjs 47811 /tmp/out/gemini.log &
node /probe/fake-muse.mjs 8787 /tmp/out/muse-model.log &
sleep 1
for spec in "$@"; do
  label=$(echo "$spec" | cut -d: -f1)
  agent=$(echo "$spec" | cut -d: -f2)
  where=$(echo "$spec" | cut -d: -f3)
  tp=$(echo "$spec" | cut -d: -f4)
  relay=$(echo "$spec" | cut -d: -f5)
  [ -n "$relay" ] || relay=-
  python3 /probe/probe.py "$label" "$agent" "$where" "$tp" "$relay" || echo "FAILED $label"
done
