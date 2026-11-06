# 0043 A held session's every shell command waits, not a list of heavy ones

**Constraint**: a session reaches a heavy tool through any shell command — `npm test`,
`npx playwright`, `make`, a script of its own, `docker compose`, a `bash -c` wrapping any
of those — so no list of command names can tell heavy from light.
**Decision**: while the machine is held, a background session's next shell command waits
in its `PreToolUse` hook, whatever it is, except a `koloft` command (so the session can
still report, message and close). Tools that start no process (reading and editing
files) are not held. Codex is held for at most 25 s, since a longer hold makes its model
poll and spend tokens (CODEX§30).
**Rejected**: holding only commands that match a list of heavy programs — misses any
wrapper or script, and needs upkeep for every new tool; light commands that also wait
cost seconds only while the machine is busy anyway.
