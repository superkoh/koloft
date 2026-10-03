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
one. A mismatch is held, the way two Claude sessions messaging each other are held.
**Rejected**: always claiming `bypass` so every message is delivered. It would let a
conductor that asks before each command push work into a session that never asks, which
is the escalation Claude's hold exists to stop.
