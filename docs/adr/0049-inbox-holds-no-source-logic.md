# 0049 The Inbox holds no logic of any source

**Constraint**: the owner wants one Inbox for every place that waits on them — Koloft's
own sessions now, GitHub, Slack or mail later — and wants a new place added without
touching the Inbox.
**Decision**: the Inbox (`src/main/inbox.ts`, `src/shared/inbox.ts`, the Inbox page) knows
only cards: three states (needs you, in progress, done), a level, blocks to show, and
buttons. A source is a platform (Koloft, later GitHub, Slack), never a feature or a
session. It posts, changes, moves and deletes its own cards; everything a card means —
its title, what its buttons do, where each outcome moves it — comes from that source.
A button can do only two things: write into an existing session (a message, or the
answer to what it is asking), or start a new session with a first prompt. The Inbox
owns only what is the owner's: the 5-second undo, a confirm for a danger button,
Dismiss, the owner's own level, move to top. The filter pills come from the keys of each
card's `where`, never from a list the Inbox knows. Koloft's own signals — every session that
waits on the owner: a question, an approval or an unexpected stop (the butler's and its
helpers' too), and a finished turn the news judge says needs the owner (not one whose reply
went to another session or to the butler's channel, nor one the owner is watching) — reach
the Inbox as cards its Koloft source (`src/main/koloftInbox.ts`) posts and closes, like any
other source. Those cards come from Koloft's own signals, never from an agent remembering to
post one: the guide's rule that agents post their finished work drew no card in real use. A
finished-turn card waits for the judge's verdict and quotes that turn's own reply; posted
from the mark alone, it raced the judge and flashed in and out.
**Rejected**: a stage table and a card kind per source (asked, answered, merged…) that the
Inbox would know — each new source would change the Inbox, and the three states already
carry what the owner acts on. Buttons that run a source's own function in Koloft's
process — a source then ships code into Koloft; a session can do the same work. A card
per session question kept by the Inbox itself — the Inbox would then know sessions.
