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
acceptable because every session may already press keys in any other session with
`koloft session keys`, so the hold would stop nothing a session could not do anyway.
**Spoof check, and its limit**: the Assist's role tells it a message starting with
`[Discord]` is the owner's own words, and Koloft's other openings tell a session who a
message comes from: `(From Koloft:)`, `(From the session "…"` and the butler's `(From the
butler, Koloft's AI, …`. Only Koloft writes those at the start of a message (a session's
own `koloft session send` is always wrapped as "From the session …"), so before Koloft
hands over a message it began with one of them, it notes it for that tab, and the tab's
`UserPromptSubmit` hook flags a prompt that begins with one and was not noted. Words a
session wrote that Koloft only passes on as they are (the text of an Inbox card button)
are never noted, so a card cannot pass as Koloft. A Claude tab gets the id of Koloft's
line noted in `<tab>.discord-ids`, and an id counts only inside Koloft's own envelope,
whose one attribute is `from-mode`. The opening is looked for right after the
`<cross-session-message …>` envelope, whatever attributes it carries, so a `SendMessage`
from another session (`from="uds:…"`, CC§13) is flagged even when it copies a noted id
(Koloft's ids are counters, easy to guess), and so is an opening typed into the tab with
no envelope (`koloft session keys` can type into any tab), as Koloft never types one into
Claude. The one exception is the fixed line a butler started fresh for a helper gets as
its first prompt (`A_HELPER_HAS_IT`): it is handed at launch, before the tab exists to
note it under, and it asks nothing, so a copy of it gains a forger nothing. Those files are readable by any program the same user
runs, so the check only catches a session that writes such an opening by accident or
because some text told it to; a program set on pretending to be the owner or the butler
can read the file and copy a line, and nothing stops it.

**Codex and Muse, by the words instead of an id**: a message reaches them as plain
text (queued for Codex, typed for Muse), with no id their hook can see (CODEX§33), while
another program can reach them the same way — `codex queue` for Codex (CODEX§33); for
Muse, another Muse session's `send_session_message` tool (MUSE§7, MUSE§9; that it lands
as a prompt is inferred, not checked). So Koloft writes the words of each such message
it hands to a Codex or Muse tab to `<tab>.discord-said`, and the hook flags a prompt
with one of those openings whose words are not there. The
words are compared with every JSON escape and every ASCII sign and space taken out, so a
later CLI that escapes a sign Node does not cannot turn the owner's words into a flag
(today both escape as Node does: CODEX§33, MUSE§9). The hook cannot tell typed text from
a message, so an opening typed into those tabs is flagged too. For a tab on another
machine Koloft writes the id or the words into that machine's hook folder over ssh before
it hands the message over, which the remote Claude, Codex and Muse hooks read.
The two files keep the names they had when only `[Discord]` was checked: a remote tab
that outlived a Koloft upgrade still runs the hook of the machine package it started
with, which reads those names.
**Antigravity has no check**: its hooks have no prompt event (AGY§12), and a check from
`PreInvocation`, which sees `lastUserInput`, is not probed yet. It has no tool of its own
for messaging another session, but another program can still reach it: by typing
(`koloft session keys`), and through its local API with the token Koloft puts on agy's
command line, which `ps` shows (AGY§16, measured on a Linux machine; on the Mac not
probed yet).
**Rejected**: putting Claude's `(Koloft message <id>)` line at the end of the Codex and
Muse text too, so every backend checks an id. The model, Koloft's own transcript reading
(the owner's words handed to a helper, a session's last prompt) and the owner would all
see that line, and each reader would need it cut off; the words file changes nothing
anyone sees.

## A message from an Inbox card button

**Decision**: when the owner presses a card button that sends a message to the card's own
Claude session (Send on a "waits for you" card, or any card action whose `session` is
the card's), the message claims that session's own class, read once Koloft has the tab
— after waking it, when it was closed — as the Discord relay does. The words are the
owner's answers inside text written by Koloft or by that same session, so no session
pushes work into another one, and this is not the rejected "always claim bypass". A card
a session posted counts as its own only while its `session` is still the poster:
`koloft inbox add` sets it to the caller, but `koloft inbox update` may move it onto
another session, and that card then claims `prompting` like any other. Claiming
`prompting` for every card held each such message to a bypass session behind the dialog,
and the owner had to press Deliver in the session's own tab, so the Inbox saved them
nothing.
**Rejected**: claiming the receiver's class for every card button. A card action may name
another session and carry text the posting session wrote; claiming the receiver's class
there would let a session that asks before each command push its text into one that never
asks, the moment the owner presses a harmless-looking label. Such a message claims
`prompting`, and a bypass receiver holds it.
**Limit**: the class is the one the session was launched with. A session the owner
switched to another mode mid-session (Shift+Tab) still holds the message: only the Assist
takes `crossSessionInbound: "accept"`.
