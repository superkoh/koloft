# Probe for #1578 and #1610: DEC 2026 frames and OSC 8 links from Muse and agy, in and out of tmux 3.3a

Runs in the `koloft-muse-probe-1411` Docker image (Debian 12, tmux 3.3a, python3, node,
muse 1.4.11) as user `u`, `--network none`. agy 1.5.3 linux-arm64 comes from the
manifest and is copied in as `probe/agy`; the status relay is `STATUS_RELAY_PY` from
`src/main/remote/statusRelay.ts`, written out as `probe/status-relay.py`.

- `probe/runall.sh <label>:<muse|agy>:<direct|tmux>:<TERM_PROGRAM|unset|x>[:<relay>] …`
  starts the two fake model servers and runs `probe.py` for each spec.
- `probe/probe.py`: the outer terminal is a python pty that answers like xterm.js
  (DA1, DA2, CPR, DSR, XTVERSION, DECRQM, OSC 10/11). `direct` runs the agent in it;
  `tmux` runs tmux with Koloft's tmux.conf in it and the agent in a pane, behind
  `teelog.py` (logs the agent's own bytes) and optionally the relay. A 160-line answer
  with links streams in, then 60 wheel notches and 8 PageUp/PageDown.
- `analyze.py` counts, per run, the redraws after the answer that drew anything
  outside a `?2026h … ?2026l` window at the outer terminal; `summary.jsonl` is its output.
