# Plan for #643: pass a page's robot check from the phone

Mockup: [mockups/643/index.html](../../mockups/643/index.html) (open the file in a browser).
Probe scripts and what they printed: this folder (`probe.cjs`, `probe-real.cjs`,
`vm-rounds.jsonl` read with `node tally.cjs`, `vm-logs/`).

## The idea in one line

The owner is the person; Koloft is their far-away finger. Koloft sends the phone a
picture of the check with a grid on it, the owner names squares, Koloft clicks there
with real input. The session never clicks the check itself.

```
session: "koloft page tap"            Koloft                         owner
        │                               │                              │
        ├──────── asks ────────────────►│                              │
        │                               ├─ at the Mac: page to front ─►│ clicks it themselves
        │                               │                              │
        │                               ├─ away: picture + card ──────►│ (Discord)
        │                               │◄──── "B5 H4 F8" ─────────────┤
        │                               ├─ real clicks, new picture ──►│
        │                               │◄──── "It passed" ────────────┤
        │◄─ "the owner says it passed" ─┤                              │
```

## What each person sees

| Who | Today | After |
| --- | --- | --- |
| Owner on the phone, session stuck at a check | Nothing they can do: the session cannot click the check, and they cannot reach the page | A picture of the check with a lettered grid, then a card with "Tap squares", "New picture", "It passed", "Give up". They type squares (for example `B5 H4 F8`); Koloft taps each and sends the page as it is then. Repeat until it passes |
| Owner at the Mac | The session says in words that it is stuck; the owner finds the page and clicks | The session's tab asks and the page comes to the front of its Workbench, as `koloft secret page` does today; the owner clicks the page themselves and presses Done |
| Owner asleep (quiet hours) | — | The command is refused the way `koloft secret` is: skip the step and report it |
| The session | Stops, or keeps trying clicks that never land | Runs `koloft page tap`, waits, then looks at the page to see whether it went through |

- The card goes where password cards go: the session's Discord room, or the butler's
  channel when it has none; it is posted by the same rule (the owner is away, or this
  session is answering a Discord message) and waits as long (9 minutes).
- It is a far-away finger for any part of a page the session names, not only for
  robot checks. A picture of that part of the page goes to Discord, as page pictures
  from `koloft open` already do.

## The command

```
koloft page tap <css selector> -- "<one line that tells the owner what to do>"
```

- The selector names the smallest element that holds the check (usually its
  `<iframe>`). It must match exactly one element in one of the session's Workbench
  pages, which is also how the page is picked (the rule `koloft secret page` has).
- Koloft scrolls that element into view, then shows it. After a tap the picture also
  takes in any frame that has come into view since the ask began (the picture question
  a tick opens is such a frame: on hCaptcha it sat off-screen until the tick).
- Reply to the session: the owner said it passed / gave up / did not answer in
  time. The session then looks at the page itself.

## How it works (mechanism; mine to choose)

- **Picture.** The page is brought to the front of its Workbench (the `stage` step
  screenshots already use), then the page's own `capturePage(rect)` takes the part to
  show (`capturePage()` with no rect drew an iframe in the wrong place in 7 of 12 VM
  captures; with a rect it was right 6 of 6). The grid is drawn over it in the hidden
  picture view Koloft already has (`shootHtml`, the capture inlined as a `data:`
  picture), so nothing is drawn into the live page.
- **Grid.** Square side = the largest of 24, `ceil(sqrt(width × height / 120))` and
  `ceil(width / 26)` CSS pixels: about 120–135 squares, columns A–Z at most. For the
  small tick box alone (about 300 × 76) that is 24 px, under the 28–30 px tick. A
  bigger part gets bigger squares, which is why the session names the smallest
  element.
- **Tap.** For each named square: a real `Input.dispatchMouseEvent` (move, press,
  release) at its middle, on the page's own session of the `webContents.debugger`
  attachment the relay already shares (`holdDebugger`), not through the relay's
  in-page events. Each tap has a time limit; when one runs out the card says so
  instead of hanging.
- **The ask.** A new ask beside the password one, because it goes several rounds
  (password asks end at the first answer) and posts a picture before its card (a card
  has no picture field). It reuses the card look, where cards are placed, the
  owner-only buttons and the "Enter it"-style box. It does not end when the page
  moves to another address; a check often does that.
- **Focus.** A real click takes the keyboard from whatever is typed in Koloft at that
  moment (measured). Taps only come from the Discord card, so this happens only when
  the owner is the one tapping from afar.
- **Sessions' own clicks do not change.** `playwright-cli` clicks stay in-page
  events (#1160 is the separate bug about those). So a session still cannot tick a
  check by itself.

Left out until seen: tapping through a frame's own CDP session. It landed where the
page-session click did not (a page that is not in front; 2 of 5 first launches after
a VM boot), but a frame of the page's own site has no session of its own, staging the
page makes it the front one, and the new picture after each tap shows a tap that
missed.

## What was measured (2026-11-11; facts in `docs/platform-contract.md` §16)

Scratch Electron 43.8.6 script (`probe.cjs`), a `<webview>` page with an iframe from
another origin that counts trusted clicks; on a Mac in a never-shown window, and in
a throwaway macOS 27 VM (5 boots) for the states a desk Mac cannot be put in.

| State of the Mac | Picture shows the iframe in its place | Real page-session click lands in the iframe | Where to read it |
| --- | --- | --- | --- |
| Window shown | yes | yes, `isTrusted` | `tally.cjs` lines 5, 6, 11, 12; `vm-logs/boot-1/shown.log` round 1 |
| Window shown, display asleep | yes | yes | `vm-logs/boot-1/shown.log` round 2 |
| Window shown, screen locked | yes | yes | `vm-logs/boot-2/shown.log` round 2 |
| Window hidden with the red button, throttling on (as shipped) | yes | yes in 11 of 11 rounds of launches that were not the first after a boot | `tally.cjs` lines 3, 4, 9, 10, 15, 16, 19, 20, 23, 24; `vm-logs/boot-2/locked-hidden.log` |
| The same, first launch after a VM boot | yes | commands unanswered for 8 s in round 1 in 5 of 5 boots; in 2 of 5 the click ran no handler in round 2 either | `tally.cjs` lines 1, 7, 13; `vm-logs/boot-1/hidden.log`, `vm-logs/boot-2/hidden-throttled.log` |
| Window never shown (how the e2e suite runs) | yes | yes | run `probe.cjs` on a Mac (3 runs, not kept as files) |
| Page is not the front tab of its Workbench | no: no frames (known, §9) | no: the click lands on the page under the iframe | every line of `tally.cjs`, "hidden page" |

Whether the unanswered commands come from the fresh boot or from the hidden window
was not separated.

Real checks, one try each in a never-shown window (`probe-real.cjs`, output not kept
as files): one real click ticked the reCAPTCHA demo's box; one on hCaptcha's box
opened its picture question, which is one `<canvas>` with freely placed pictures (no
element per picture, so only a grid can point into it); a Turnstile frame exposes no
element at all. A Cloudflare whole-page check moved on after one click, but a later
load passed with no click, so that try proves nothing.

## Not probed yet (the first steps of the build, before code depends on them)

1. A whole pass by a person through the grid on a real check, and whether the check's
   own time limit outlasts a Discord round trip. Only a person may solve it, so this
   is the build's one hand-test.
2. The same picture and click in the real app, where three things differ from the
   probe: a relay client turns on `Emulation.setFocusEmulationEnabled`; a staged page
   sits behind the Workbench when it is closed or shows another session; a page can be
   zoomed.
3. Answering the "Tap squares" box later than Discord's 3 seconds (a deferred
   answer), since taps plus a new picture take longer.
4. `koloft secret page`-style page lookup from a session on another machine (only
   `koloft secret url` has a remote e2e case).

## Every kind of session tab

The command runs in Koloft's main process and finds the page among the tab's own
Workbench pages, so the command itself does not depend on the kind of tab. What
differs is whether the session can see the check and name its element.

| | This Mac | Another machine (SSH) |
| --- | --- | --- |
| Claude Code | as above | the same (see "Not probed yet" 4) |
| Codex, Muse Code, Antigravity | as above | left out in practice: these sessions have no browser control of the Workbench (`src/shared/agentGuide.ts`, WEB PAGES), so they cannot see that a check came up or name its element. Inferred from the code, not run. The command would work for them the day they get browser control |

## The one choice for the owner: who clicks the check

| | What happens | Cost |
| --- | --- | --- |
| **A. Only the owner, through Koloft** (this plan; recommended) | Every check waits for the owner's taps, at the Mac or from Discord | A new command, a several-round card and the grid picture. Even a one-tick box costs the owner a look at the phone; a picture question takes a few rounds of typing squares, and may run out of time (not probed) |
| B. Let the session's own clicks reach these frames too (#1160), and ask through today's question card | A session may tick a plain box by itself (one real click ticked the reCAPTCHA demo today) and asks the owner in words only for a picture question | Checks get passed with nobody looking, under the owner's accounts. A real click takes the keyboard from whoever types at the Mac, so it needs an "only while away" gate. A model may refuse to touch a check anyway |
| C. Build nothing | A check still needs the owner at the Mac; the session's question already reaches the phone | A remote owner stays stuck until back |

Looked at and not offered: a "tick it for me" button for the plain box, with the
grid only for picture questions. It needs Koloft to find the tick inside the frame
(possible on two of the three checks tried), and the tick very often opens a picture
question anyway, so it is more code for one saved step.

## Existing users after the update

Nothing they have changes. It is one new command in the text sessions read
(`koloft help`); no setting, no stored data.

## Not covered

- A puzzle that needs a drag (slide the piece): a still picture cannot show the piece
  moving while it is dragged.
- A check that asks to type letters inside its frame.
- A check that judges the browser, not the click (it may refuse whatever is tapped).
- A picture question taller or wider than the page's visible area: the picture shows
  only what is in view.

## Tests

- Unit: grid size and "square name → point" for the sizes in the mockup; the box of
  "named element plus frames that came into view".
- e2e, fake Discord (the `discord-secret` pattern): a local page with an iframe from
  another origin that counts trusted clicks, at a known place. Owner away: the room
  gets a picture (two pixels checked, so a misplaced iframe fails) and the card; the
  box is filled with a square; the iframe's counter is 1 and its click was
  `isTrusted`; "It passed" ends the command. Owner at the Mac and not answering
  Discord: the ask shows in the tab and nothing is posted.
- The same case from a Claude Code session on the lab machine.
