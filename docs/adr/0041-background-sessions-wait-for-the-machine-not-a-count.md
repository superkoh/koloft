# 0041 Background sessions wait for the machine, never for a session count

**Constraint**: on the night of 2026-10-17 about 13 sessions installed dependencies,
built and ran e2e at once and the Mac stalled (load 100–200 on 10 cores, PLATFORM§59).
What overloads the machine is the tools a session starts — browsers, builds, docker,
simulators — not the agent processes, which idle at 200–470 MB each.
**Decision**: the owner chose (October 2026) that Koloft gates only by what the machine
itself shows (memory pressure, load per core) and only for sessions it started for
someone else (`koloft session new`, a scheduled job): their launch queues and their next
shell command waits while background work keeps the machine busy. Sessions the owner
opens, the butler, and a session the owner typed into or freed are never held. No
number of sessions is a limit anywhere. Background launches are spaced a little even on
a roomy machine, since load averages show a burst only after it has started.
**Rejected**: a cap on concurrent sessions (the earlier "at most 4" rule kept in an agent
memory) — the owner found 3–4 too few, and it counts the wrong thing: four sessions
running e2e can still stall the Mac while ten idle ones cost nothing. A rule in the agent
prompts asking models to start fewer sessions — not a mechanism, and only some sessions
read it.
