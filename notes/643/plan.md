# Plan for #643: pass a page's robot check from the phone

Mockup: [mockups/643/index.html](../../mockups/643/index.html) (open the file in a browser).
Probe scripts and what they printed: this folder.

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
| Owner on the phone, session stuck at a check | Nothing they can do: the session cannot click the check, and they cannot reach the page | A picture of the check with a lettered grid, and a card with "Tap squares", "New picture", "It passed", "Give up". They type squares (for example `B5 H4 F8`); Koloft taps each and sends the page as it is then. Repeat until it passes |
| Owner at the Mac | The session says in words that it is stuck; the owner finds the page and clicks | The session's tab asks, with the page brought to the front in its Workbench (the same treatment as `koloft secret page` today); the owner clicks the page themselves and presses Done |
| Owner asleep (quiet hours) | — | The command is refused the way `koloft secret` is: skip the step and report it |
| The session | Stops, or keeps trying clicks that never land | Runs `koloft page tap`, waits, then reads the page to see whether it went through |

The card goes where password cards go today: the session's Discord room, or the
butler's channel when it has none. It times out like a password card.

## The command

```
koloft page tap [<css selector>] -- "<one line that tells the owner what to do>"
```

- No selector: Koloft shows the check, meaning the frames on the page that come
  from another site (the place every measured check lives). No such frame: the whole
  visible page.
- A selector: that element's box instead, for a check drawn by the page itself.
- Reply to the session: the owner said it passed / gave up / did not answer in
  time. The session then looks at the page itself.

## How it works (mechanism; mine to choose)

- **Picture.** The page is brought to the front of its Workbench (the `stage` step
  screenshots already use), then the page's own `capturePage(rect)` takes the part to
  show (`capturePage()` with no rect drew an iframe in the wrong place in 7 of 12 VM
  captures; with a rect it was right 6 of 6). The grid is drawn over it in the hidden picture view Koloft already has
  (`shootHtml`), so the live page is never touched.
- **Grid.** Square side = `max(24, ceil(sqrt(width × height / 120)))` CSS pixels:
  at most about 120 squares, and never wider than a 28 px tick box. Columns are
  letters, rows are numbers.
- **Tap.** For each named square: a real `Input.dispatchMouseEvent`
  (move, press, release) at its middle, through the `webContents.debugger`
  attachment the relay already shares (`holdDebugger`), not through the relay's
  in-page events. A point inside a frame that is its own CDP target is sent through
  that frame's own session, with the frame's offset taken off.
- **A tap that gets no answer.** Each tap has a time limit; when one runs out the
  card says so ("Koloft could not tap C4; try New picture") instead of hanging.
- **Focus.** A real click takes the keyboard from whatever is typed at the Mac
  (measured). Taps only come from the Discord card, so this happens only when the
  owner is the one tapping from afar.
- **Sessions' own clicks do not change.** `playwright-cli` clicks stay in-page
  events (#1160 is the separate bug about those). So a session still cannot tick a
  check by itself.

## What was measured (2026-11-11; facts in `docs/platform-contract.md` §16)

Scratch Electron 43.8.6 script (`probe.cjs`), a `<webview>` page with an iframe from
another origin that counts trusted clicks; on a Mac in a never-shown window, and in
a throwaway macOS 27 VM for the states a desk Mac cannot be put in.

| State of the Mac | Picture of the page shows the iframe | Real click lands in the iframe |
| --- | --- | --- |
| Window shown | yes | yes, `isTrusted` |
| Window shown, display asleep or screen locked | yes | yes |
| Window hidden with the red button (as shipped, throttling on) | yes | yes in 9 of 9 rounds; see the note |
| Window never shown (how the e2e suite runs) | yes | yes |
| Page is not the front tab of its Workbench | no: no frames (known, §9) | only through the iframe's own session |

Note: the first Electron launch after each VM boot (4 boots) had commands that did
not answer within 8 s; later launches in the same VM had none. Not separated from the
VM just having booted.

Real checks, one try each in a never-shown window: one real click ticked the
reCAPTCHA demo's box; one on hCaptcha's box opened its picture question, which is one
`<canvas>` (no element per picture, so only a grid can point into it); a Turnstile
frame exposes no element at all. A Cloudflare whole-page check moved on after one
click, but a later load passed with no click, so that try proves nothing.

## Every kind of session tab

| | This Mac | Another machine (SSH) |
| --- | --- | --- |
| Claude Code | as above | the same: the page lives in the Mac's Workbench, the command goes over Koloft's connection like `koloft secret` |
| Codex, Muse Code, Antigravity | as above | left out by an older limit: these sessions cannot drive the Workbench browser at all, so they never reach a check there |

Inferred, not checked: that a command like `koloft secret page` finds the Workbench
page when it is run from a Claude Code session on another machine (only
`koloft secret url` has a remote e2e case). It is the first thing to check when
building.

## The one choice for the owner: who clicks the check

| | What happens | Cost |
| --- | --- | --- |
| **A. Only the owner, through Koloft** (this plan; recommended) | Every check waits for the owner's taps, at the Mac or from Discord | A new command, card and grid picture. Even a one-tick box costs the owner a look at the phone |
| B. Let the session's own clicks reach these frames too (#1160), and ask through today's question card | A session often ticks a plain box by itself (one real click ticked the reCAPTCHA demo today), and asks the owner in words only for a picture question | Sessions pass robot checks with nobody watching, which sites forbid and can punish the account for; a real click also takes the keyboard from whoever types at the Mac, so it needs an "only while away" gate; a model may refuse to touch a check anyway |
| C. Build nothing | A check still needs the owner at the Mac | A remote owner stays stuck |

## Existing users after the update

Nothing they have changes. It is one new command in the text sessions read
(`koloft help`); no setting, no stored data.

## Not covered

- A puzzle that needs a drag (slide the piece): a still picture cannot show the piece
  moving while it is dragged.
- A check that asks to type letters inside its frame.
- A check that judges the browser, not the click (it may refuse whatever is tapped).
- A check on a page the owner opened themselves: the session cannot see those tabs.

## Tests

- Unit: grid size and "square name → point" for the three sizes in the mockup; the
  "frames from another site" box.
- e2e, fake Discord (the `discord-secret` pattern): a local page with an iframe from
  another origin that counts trusted clicks. Away: the room gets a picture and the
  card; the box is filled with a square; the iframe's counter is 1 and its click was
  `isTrusted`; "It passed" ends the command. At the Mac: the ask shows in the tab and
  nothing is posted.
- Remote Claude Code: the same e2e case started from a session on the lab machine.
