# Plan for issue #579 — a picture next to a session's Discord question

## Core idea (one line)

What a session showed with `koloft open` / `koloft diff` during the turn that asks the owner
reaches the phone next to the question, whenever that question card is posted.

## What already works on main (b98c0372), no change

```
session with a room, owner away      its Discord room
  koloft open shot.png  ───────────▶ [shot.png]        (copyToPhone → sendPhoneCopy, up to 20 MB)
  AskUserQuestion       ───────────▶ ❓ "X is waiting for you" card with buttons
```

- `copyToPhone` (`src/main/index.ts:5930`) sends the copy only when `relay.reaches(tab)`
  (owner away, or this turn answers Discord) and the turn is not quiet (`index.ts:5936`).
- Question cards go to `askChannelOfTab` (`index.ts:5922`): the room, or the butler's channel
  for the butler and the helpers in its folder (`relay.ts:625`, `:796`, `:582`).
- A file on an SSH machine is read there and sent (`index.ts:5948`). E2e:
  `test/e2e/discord-room-copies.spec.ts`, a local and a remote room. Shipped in #1450, #1499.

## Gap 1 — the picture was shown while the owner was at the Mac

```
owner at the Mac                         owner gone (5 min idle, presence.ts AWAY_AFTER_MS)
  koloft open shot.png → Workbench only
  (keeps working) …                       AskUserQuestion → card posted in the room at once
                                          — or —
  AskUserQuestion → card held (relay.holds)  → posted when the owner leaves / a room opens
phone: the question, no picture
```

Both happen today: the copy is decided when `koloft open` runs, the card when it is posted.

Fix: Koloft keeps, per tab, the list of `koloft open` / `koloft diff` calls of the current
turn that it did not try to send (it chose no channel: owner at the Mac, or a quiet turn).
Right before any question card is posted — `postAsk` (`relay.ts:599`, used by Claude and Codex
cards, early or late) and the unreadable-ask card (`relay.ts:588`, Muse and Antigravity) — it
first sends that list to the card's channel, waiting for each send to finish, then posts the
card. A send that fails posts the room's existing "⚠ Koloft could not send …" line. A call
that was tried at `koloft open` time (sent, still sending, or refused as too large) is not in
the list, so nothing goes twice. The list is emptied once sent, when the session is prompted,
and when the tab goes.

## Gap 2 — a helper in the butler's own folder

Its question card goes to the butler's channel, but its `koloft open` sends nothing
(`phoneChannelOf` = `butler.channelOfTab ?? roomOfTab`, both undefined for a helper).
Fix: only `copyToPhone` picks its channel with `askChannelOfTab` (same as today for the butler
and for sessions with a room). `phoneChannelOf` itself stays, because it is also the relay's
reply channel (`index.ts:3952`): a helper's replies must keep reaching the owner only through
the butler (`discord-flow.spec.ts:730`).

## What Discord shows

No new card layout and nothing inside the card: the picture is its own message right before
the card, as today's copies are. `Card` (`src/main/discord/cards.ts`) is a Components V2
container with text and buttons only, and the copy path already handles pages, Markdown,
diffs and files with the 20 MB limit; the issue allows "send a file into its own thread". No
Koloft screen and no Inbox card changes, so no mockup.

## Docs

- `test/CLAUDE.md:362`: replace "The card carries text only … have the butler send a picture
  first" with "run `koloft open <shot>` before asking; it reaches the phone with the card".
- `src/shared/agentGuide.ts:157` (`koloft open`): add the helpers of the butler to who gets a
  copy, and say a copy shown while the owner is at the Mac follows the question if the owner
  is gone by then.

## Eight tab kinds

| | Local | Remote (SSH) |
|---|---|---|
| Claude Code | Gap 1 fixed (ask card) | Same; file read on the machine; the ask hook comes back over ssh (inferred, not checked) |
| Codex | Gap 1 fixed (ask card) | Same |
| Muse | Gap 1 fixed, in a room only (Muse questions are cards only in a room) | Same |
| Antigravity | Gap 1 fixed, in a room only (same) | Same |

Named differences: for Codex, Muse and Antigravity "prompted" means "turned to working", so
after the owner approves something at the Mac the earlier list is forgotten (the owner saw it
there). Gap 2 is only for helpers in the butler's folder, which is always on the Mac; a Muse or
Antigravity helper there has no question card, so its copy lands alone. A page on a remote
machine is still not pictured (unchanged since #1499).

## Size and tests

- About +50/−5 lines under `src/`.
- E2e (fake-claude, the only fake that can type a `koloft` command on cue):
  `discord-room-copies.spec.ts` — owner at the Mac, `koloft open`, ask; owner leaves; the room
  gets the file, then the card (the held card is posted at once by the owner writing in the
  room, `relay.ts:293`, not by the 30 s check). `discord-flow.spec.ts` — a helper's
  `koloft open` while away lands in the butler's channel, its reply still does not.

## Out of scope

- Plain `open <file>` in local Codex, Muse and Antigravity tabs goes to the Workbench only and
  sends no copy (`codexSessions.ts:852`), today and after.
