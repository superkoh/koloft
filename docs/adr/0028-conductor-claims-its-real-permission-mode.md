# 0028 A conductor's message to another session claims the conductor's real permission mode

**Constraint**: a message written to a Claude session's messaging socket says which
permission class sent it (`from-mode="bypass"` or `"prompting"`, CC§13). A receiver whose
class differs holds the message behind a "Held message from another session" dialog
instead of acting on it. Claude does not check the claim: anything on this Mac that can
reach the socket may say what it likes.
**Decision**: Koloft claims the class the sender really runs in — `bypass` only when
Koloft itself launched that sender with permission checks skipped (a Claude session with
`--dangerously-skip-permissions`, a Codex session with approvals and the sandbox off),
`prompting` otherwise. This holds for a conductor and for a session reporting back to
the session that started it. A mismatch is held, the way two Claude sessions messaging
each other are held. So that a session's report back is not held, a session that
`koloft session new` starts is launched with its starter's own class (the owner's choice
for the starter), whether the starter is a conductor or not: a Codex session started by a
bypass Claude conductor runs with approvals and the sandbox off.
**Rejected**: always claiming `bypass` so every message is delivered. It would let a
conductor that asks before each command push work into a session that never asks, which
is the escalation Claude's hold exists to stop.

## The owner's Discord messages to a Claude Assist

**Decision**: the Discord relay hands an owner message to a Claude Assist on the Assist's
own message socket (not typed into its input box, where it would be sent together with
whatever the owner is typing at the Mac), and claims the Assist's own class. That is not
the rejected "always claim bypass": the sender is the owner, not another session, so no
session pushes work into one that asks more than it does.
**Trade-off**: the owner can switch the Assist's mode mid-session (Shift+Tab), and then
the claimed class no longer matches and the message would be held. So the Assist's
settings take `crossSessionInbound: "accept"` (CC§13), which removes the hold for the
Assist alone: any local session's message reaches it whatever class it claims. This is
acceptable because the Assist's gate (ADR-0029) already limits what it can do, whoever
asked.
**Spoof check, and its limit**: the Assist's role tells it a message starting with
`[Discord]` is the owner's own words. Koloft notes the id of every Discord message it
sends in `<tab>.discord-ids`, and the Assist's `UserPromptSubmit` hook flags a
`[Discord]` message whose id is not there. That file is readable by any program the same
user runs, so the check only catches a session that writes `[Discord]` by accident (for
example in a `koloft session send`); a program set on pretending to be the owner can
read an id and is stopped only by the gate.
