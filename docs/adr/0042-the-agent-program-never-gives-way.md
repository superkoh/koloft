# 0042 Only a background session's tools give way, never the agent program

**Constraint**: `taskpolicy -b` keeps the foreground fast under load, but a process under
it stalls for seconds: a short command in a `-b` pty took 4.5 s (worst 7.7 s) with 40
busy processes, against 37 ms at normal priority (PLATFORM§59). Koloft types into an
agent's terminal with keys 300 ms apart, and an agent that stalls reads two of them
together and drops the command (the #684 / #837 failure).
**Decision**: while the machine is busy Koloft lowers the processes under a background
session's agent — its builds, test runners, browsers — and leaves the `claude`, `codex`,
`muse` or `agy` program itself at normal priority. A new tool is caught on the next
5-second look; everything is lifted as soon as the machine is roomy or the owner frees
the session.
**Rejected**: lowering the whole tab, agent included — simplest, since children inherit
it, but it breaks Koloft's typing into that tab. `nice` — measured to make no
difference. `taskpolicy -c utility` at launch — no cost when idle, but it can only be set
at launch, never lifted, and still stalls the agent near a second.
