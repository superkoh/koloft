# 0042 The agent program sits above its tools; only a background session's tools give way

**Constraint**: an agent program at the same priority as the builds and tests it started
waits for the CPU behind them, so its screen and its typing stall while they run. On
macOS `taskpolicy -a` at launch puts a program's main thread at priority 46 instead of
31, the programs it starts stay at 31, and it does nothing to a program that already
runs (PLATFORM§59). `taskpolicy -b` keeps the foreground fast under load, but a process
under it stalls for seconds: a short command in a `-b` pty took 4.5 s (worst 7.7 s) with
40 busy processes, against 37 ms at normal priority. Koloft types into an agent's
terminal with keys 300 ms apart, and an agent that stalls reads two of them together and
drops the command (the #684 / #837 failure).
**Decision**: Koloft starts every agent program that runs on this Mac through
`taskpolicy -a` — `claude`, `muse`, `agy`, and the Codex screen of a tab here or on
another machine — so it sits above whatever it starts. While the machine is busy Koloft
lowers the processes under a background session's agent — its builds, test runners,
browsers — and never the agent program itself. A new tool is caught on the next 5-second
look; everything is lifted as soon as the machine is roomy or the owner frees the
session.
**Rejected**: a variable in the tab's environment that Koloft's `claude` wrapper reads
to lift the program — every `claude -p` the agent starts inherits it and is lifted too,
so the agent's own helpers compete with it again. Lifting an agent only while its tab is
on screen — a running program cannot be moved between 31 and 46. Lowering the whole tab,
agent included — simplest, since children inherit it, but it breaks Koloft's typing into
that tab. `nice` — measured to make no difference. `taskpolicy -c utility` at launch —
no cost when idle, but it can only be set at launch, never lifted, and still stalls the
agent near a second.
