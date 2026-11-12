# 0042 The agent program sits above its tools; tools give way only while memory is critical, and only in tabs nobody looks at

**Constraint**: an agent program at the same priority as the builds and tests it started
waits for the CPU behind them, so its screen and its typing stall while they run. On
macOS `taskpolicy -a` at launch puts a program's main thread at priority 46 instead of
31, the programs it starts stay at 31, and it does nothing to a program that already
runs (PLATFORM§59). `taskpolicy -b` keeps the foreground fast under load, but a process
under it stalls for seconds: a short command in a `-b` pty took 4.5 s (worst 7.7 s) with
40 busy processes, against 37 ms at normal priority. Koloft types into an agent's
terminal with keys 300 ms apart, and an agent that stalls reads two of them together and
drops the command (the #684 / #837 failure). A lowered process that later becomes the
agent — the login shell a Claude Code tab starts in, before it `exec`s the agent — stays
lowered after the `exec`. This Mac sits at memory pressure "warning" about 7% of the
time, mostly at night, when every scheduled run and helper session is a tab nobody looks
at and nobody is there to lift one; "critical" showed twice in 15 days of the log.
**Decision**: Koloft starts every agent program that runs on this Mac through
`taskpolicy -a` — `claude`, `muse`, `agy`, and the Codex screen of a tab here or on
another machine — so it sits above whatever it starts. Only while memory pressure reads
critical twice in a row does Koloft lower anything: in each agent tab on this Mac that is
not the one last on screen, the processes under the agent — its builds, test runners,
browsers. It never lowers a process whose parent is Koloft (the tab's own terminal
process and the Codex server, whatever their command line says at that moment), nor one
named like an agent. A tab that comes on screen is lifted at once; one whose sidebar row
the owner clicks, or that the owner types into, stays lifted after they leave it, until
memory leaves critical, when everything is lifted. A lift reads the process table again
and lifts what Koloft lowered and everything under those, since a lowered tool's later
children are lowered with it and lifting the parent does not reach them; a tool Koloft
never lowered is left as it is.
**Rejected**: lowering at "warning", or on high load — it would fire most nights and slow
unattended work five- to sixfold with nobody to lift it, which is how the queue of #846
came to hold nearly every session (#862 turned it off). Holding a background tab's shell
commands with a hook, and queueing background launches — both removed with this record's
predecessors 0041 and 0043; neither had run since #862. A variable in the tab's
environment that Koloft's `claude` wrapper reads to lift the program — every `claude -p`
the agent starts inherits it and is lifted too, so the agent's own helpers compete with it
again. Lifting an agent only while its tab is on screen — a running program cannot be
moved between 31 and 46. Lowering the whole tab, agent included — simplest, since
children inherit it, but it breaks Koloft's typing into that tab. Telling the agent by
its name alone — the shell before the `exec`, and a launcher script, do not carry it.
`nice` — measured to make no difference. `taskpolicy -c utility` at launch — no cost when
idle, but it can only be set at launch, never lifted, and still stalls the agent near a
second.
