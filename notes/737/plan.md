# Plan: draw only the part of a long inline diff that is near the screen (#737, item 3)

**In one line:** when you open a long diff (more than 1,000 rows) in a file tab or in
the editor's "On disk vs. yours" panel, Koloft draws only the rows near the screen.
⌘F, ⌘A, ⌘C, drag-select, go to line and coming back to the tab all behave as they
do today. Two things change on purpose: with ⌘F open, the view no longer snaps back
to the match after you scroll away (#1870), and a fast, far scrollbar drag can show
an empty strip for a few frames (the one Question for the owner).

## The picture

```
 .idiff  (the box that scrolls)
 ┌──────────────────────────────────────────┐
 │ chunk 0   rows 1–250      drawn          │  ← lead-in: one screen above
 │ chunk 1   rows 251–500    drawn          │  ← on screen
 │ chunk 2   rows 501–750    drawn          │  ← lead-in: one screen below
 │ chunk 3   rows 751–1000   NOT drawn ─────┼─ an empty box as tall as its rows,
 │ …                                        │  holding one hidden text node with
 │ chunk 17  rows 4251–4500  NOT drawn      │  the chunk's code (for ⌘F)
 └──────────────────────────────────────────┘
```

A chunk is 250 rows. A chunk is drawn when:

- (a) it is on screen or within one screen of it;
- (b) the selection, or the caret, is in it, or the selection spans it;
- (c) a ⌘F jump or a "go to line" is landing in it.

Every other chunk is an empty box as tall as its rows, holding their text in a
`hidden` element. A diff of up to 1,000 rows is drawn whole, with the same DOM as
today.

This is the shape Changes already uses for whole files (`UndrawnRows` in
`ChangesView.tsx`, PLATFORM§24, test WB-C16), applied to the rows inside one diff.

**About the earlier "not done the windowing way" (Decided, 2026-10-19).** That line
records the October finding: windowing as tried then broke ⌘F and copy, so item 3
was left open until a design for find and copy existed. The Next step at the time
asked for exactly that design. This plan is that design. It does not reverse a
product decision.

## Is it still worth doing? (measured 2026-11-13 on `main` 668a5d18)

Measured in the hidden e2e window, where frames do run. The diff is 4,500 rows: a
4,000-line file with 500 lines changed (`long-diff.probe.ts`). The "After" column
was not measured on the built design, which does not exist yet. It comes from
stand-ins, named in the last column (`windowing.probe.ts`).

| What                               | Today (4,500 rows drawn)  | After (stand-in)          | Stand-in used                                              |
| ---------------------------------- | ------------------------- | ------------------------- | ---------------------------------------------------------- |
| Open the diff: long tasks          | 300–308 ms (two ~150 ms)  | none over 50 ms           | a 562-row diff opened whole                                |
| Width step (4 px), forced relayout | 34–74 ms, mostly ~40 ms   | 3.7–6.5 ms                | the 4,500-row diff with 16 chunks swapped by hand          |
| Real divider drag (60 mouse steps), frame gaps | avg 23–27 ms, worst 119–335 ms, 56–61 frames over 50 ms | avg 6.3–6.4 ms, worst 12–21 ms, none over 50 ms | the same hand-swapped diff (`divider-drag.probe.ts`, 4 drags each) |
| A change on disk                   | 155–183 ms                | not measured              | (it re-renders only the drawn chunks; inferred ≈ open)     |
| Type a ⌘F query, 4,500 matches     | 125–264 ms                | none over 50 ms           | the hand-swapped diff                                      |
| ⌘F open, one more chunk draws      | (nothing draws today)     | none over 50 ms           | the hand-swapped diff                                      |

The stand-ins leave out work that the built design adds: mapping colors for all
4,500 rows (already done today), building 16 hidden texts, and estimating 4,500 row
heights (measured alone: 10–19 ms for 4,500 rows, see Heights). Open should still
stay well under today's ~300 ms. The first build step re-runs `long-diff.probe.ts`
on the real build and reports the real After.

The October numbers in the issue (0.9–1.1 s to open) are now about 0.3 s, because
coloring moved to a worker (#1569, #1585). What is left is two React renders of every
row. Dragging the Workbench divider with that diff open measurably stutters today
(about a third of the frames take over 50 ms). On the hand-swapped stand-in, no frame
did. The stand-in has no React re-render and no height re-estimate per step; the
first build step re-measures on the real build. I judge it still worth doing.
Option B of the Question on the issue is to leave it.

## What a user sees change

| Case                                             | Today                          | After                                                                 |
| ------------------------------------------------ | ------------------------------ | --------------------------------------------------------------------- |
| Open a 4,500-row diff                            | two ~150 ms stalls             | none over 50 ms (on a 562-row stand-in)                               |
| Drag the Workbench divider with that diff open   | a third of frames over 50 ms   | none over 50 ms (on the hand-swapped stand-in)                        |
| ⌘F: count, order, Enter / ⇧Enter                 | all matches, in order          | the same (4,499 = 4,499 on the stand-in)                              |
| ⌘F: jump to a match far below                    | one jump, lands on the match   | the same, by design: the chunk is drawn before the scroll (see Find; not probed yet) |
| ⌘F open, then scroll away by hand (long diff)    | stays where you scroll         | the same (needs the #1870 fix, below)                                 |
| ⌘F open in Changes, scroll away by hand          | snaps back to the match (#1870) | stays where you scroll (the #1870 fix; every ⌘F screen gets it)      |
| ⌘F open, the file changes on disk (any screen)   | the view follows the active match if it moved off screen | the view stays; the count and highlights update (same fix) |
| ⌘A then ⌘C                                       | the whole diff                 | the same text; the first ⌘A draws every row (~150 ms, inferred)       |
| Drag-select across many rows, then ⌘C            | what you dragged over          | the same                                                              |
| Click a row, scroll far, shift-click, then ⌘C    | from the clicked row onward    | the same (the caret's chunk stays drawn)                              |
| Switch Diff → Source → Diff, or leave and return | back at the same row           | the same (measured heights are kept; see Heights)                     |
| Drag the scrollbar thumb very fast, far          | rows always there              | an empty strip may show until the new rows draw: under 50 ms on the stand-in, so up to about three frames (as in Changes, #1568 #4) |
| Diffs of up to 1,000 rows                        | —                              | the same DOM as today; only the ⌘F rows above (the #1870 fix) apply   |

**The one trade-off for the owner: the fast-thumb strip.** Every windowed list has
it. Changes ships it today, but #1568 tracks it there as a defect, not as an
accepted state. A larger lead-in only helps with short jumps and makes every
divider-drag step slower, so it cannot remove the strip. The options are on the
issue as a Question. My pick is to accept it: ~0.3 s less on open and a smooth
divider drag, against a strip of a few frames that shows only on a fast, far thumb
drag in a diff of more than 1,000 rows.

## How each part works

### Heights

- **Undrawn chunk height:** the sum of its rows' heights, worked out from the text.
  It packs words into lines the way `pre-wrap` + `break-word` does:
  - break at spaces;
  - a word longer than the line breaks anywhere;
  - a tab goes to the next stop of 8 characters;
  - each CJK character is its own piece.

  Character widths come from canvas `measureText` with the code's computed font, so
  CJK falling back to another font is measured, not assumed to be 2 columns.
- **How good the estimate is** (`row-height.probe.ts`): 4,500 rows from the repo's
  own files, with CJK and tab lines mixed in. The sample is about 91% Markdown prose
  (`docs/platform-contract.md`) and 9% TSX, so indented code is lightly covered.
  - At a 432 px code column: total height off by 0.1%, 8 of 4,500 rows off.
  - At 234 px: off by 0.6%, 85 rows off.
  - These are whole-diff totals, where errors can cancel. They are not a bound for
    one chunk. A third width (900 px) did not take effect in the probe and is not
    reported.
  - Counting characters alone was off by 0.3% and 6.2%, so the word packing is
    needed.
  - One pass over 4,500 rows: 10–19 ms, including reading each row's text from
    the DOM.
- **Measured heights win:** after a chunk draws, and again whenever it is
  re-measured, its real `offsetHeight` is kept in a small module-level cache keyed by
  (the chunk's text, the code column's width). The cache is written when a chunk is
  drawn or measured, never when it is undrawn, so the chunks on screen at unmount are
  in it.
- **The first render after a remount uses the last known column width.** The cache
  keeps that width, per diff. The width can only be read from the DOM after the
  first commit, and `ArtifactPane`'s restore runs in that same commit, before any
  re-render `InlineDiff` asks for. So the first render must already have the right
  heights. With no known width (a diff never shown before), the first render draws
  no chunk boxes. `scrollTop = want` then clamps, and the next child-list change
  retries it (the restore's MutationObserver), once the width is known and the
  boxes are in.
  - A remount rebuilds the same layout as long as the diff and the width are the
    same: the view switch Diff → Source → Diff, or a file tab mounting again after a
    session switch (ADR-0016).
  - So `ArtifactPane`'s numeric scroll restore (`scrollTop = want`) lands on the
    same row as today: every chunk the user scrolled through has its measured
    height again, and the rest get the same estimate as before.
  - A chunk whose text did not change after a change on disk keeps its height too.
- **Width change:** a ResizeObserver on `.idiff`. Drawn chunks reflow by
  themselves. The undrawn estimates are redone once the width has stayed the same
  for one frame, not on every step of a drag.
  - Each row's piece widths are cached, so a redo only packs lines again.
  - Until then the old heights stand. The cache entries for the old width are
    simply not used.
  - A hidden background tab that holds a long diff pays the same small cost.
- **Rows above the view changing height** (estimate → measured): Chromium's scroll
  anchoring (`overflow-anchor: auto`, the default) keeps the rows on screen still
  (inferred, not checked; an e2e case checks it).

### Which chunks are drawn

- `InlineDiff` splits `shown` (the rows it draws today, up to `MAX_INLINE_ROWS`) into
  chunks of 250 rows when there are more than 1,000 rows.
- A `scroll` listener on `.idiff` works out which chunks lie within one screen of
  the view, from running totals of chunk heights.
  - If that set changed, it commits the new set with `flushSync`. Otherwise React
    19 treats a `scroll` update as a continuous event and commits it a task later,
    so the new rows would show a frame late (read from the React 19.3.1 source, not
    probed). If the set did not change, it does nothing.
  - `flushSync` is used only from native event listeners (`scroll`,
    `selectionchange`, `find-reveal`), never from an effect. Inside an effect React
    is committing, so `flushSync` does nothing but warn.
  - Each chunk is a `memo` component, so a commit re-renders only chunks that change
    between drawn and undrawn.
- **Selection and caret:** on `selectionchange`, every chunk from the one holding
  the selection's start to the one holding its end stays drawn. An end outside the
  diff counts as the first or last chunk, but only when the selection really
  crosses the diff (`containsNode(diff, true)`). A selection made wholly elsewhere
  draws nothing. This also holds for a collapsed
  selection (a caret), so after a click, a far scroll and a shift-click, the click's
  row is still in the DOM.
  - Newly covered chunks are drawn with `flushSync`, so a ⌘C pressed right after
    finds the rows in the DOM.
  - Changes keeps a selected block drawn the same way (`stays` in `markVisible`).
- **Colors:** the colored HTML per row (`rowHtmlObjs`) is still computed for every
  row, as today. A drawn chunk takes its rows' objects by index, so the
  `dangerouslySetInnerHTML` wrappers keep their identity, and drawing a chunk again
  does not rebuild a row whose HTML did not change (PLATFORM§25).
- **Truncation hint** ("Diff truncated — showing first 5,000…"): stays after the
  last chunk, unchanged.

### Find (⌘F)

Find keeps reading the DOM (`useDomFind.ts`). The text of rows that are not drawn is
put into the DOM, built from the diff data, as one hidden text node per chunk.

- **Count and order:** a chunk's hidden text is its rows' code joined with nothing
  in between. A TreeWalker over drawn rows sees exactly that, since the gutter
  number and sign are skipped by `DIFF_GUTTER_NOT_FILE_CONTENT`.
  - One helper makes both forms: `' '` for an empty row before colors land, and
    `' '` after (the drawn row's `&nbsp;`).
  - On the stand-in, `value_` gave 4,499 matches with 4,000 of 4,500 rows hidden.
    That is the full count by construction: every one of the 4,500 rows holds
    `value_` once, except the one needle row. The stand-in copied the hidden text
    from the drawn rows. "Text built from the data = DOM text" is a unit test of the helper, not
    yet a measurement.
- **Highlight:** drawn rows show it as today. A hidden range has no box and paints
  nothing; it is off screen anyway.
- **Jump to the Nth match (typing, Enter, ⇧Enter, the arrows), drawn first:** before
  `useDomFind` scrolls to a range that sits inside a `[hidden]` element, it
  dispatches a bubbling `find-reveal` event on that element.
  - `InlineDiff` listens on its root and draws that chunk with `flushSync`. It
    marks the event handled (`preventDefault`), and the chunk stays drawn until the
    jump ends.
  - When the event was handled, `useDomFind` recomputes the ranges in the same task
    (the active index stays) and scrolls once to the real range. It does not check
    whether the old node is gone: a live Range moves to the parent when its node is
    removed, so that check cannot be read from the range.
  - `flushSync` is legal from all three places `render` runs: React's `onChange`
    (typing), keydown or click (next, prev), and the observer's frame callback
    (recompute). None of them is inside a render or commit.
  - Result by design: one jump, landing exactly, as today. Not probed yet; an e2e
    case checks it.
  - Changes does not listen yet, so a match in an undrawn block keeps today's
    behavior: the block's box, then the line. The same event could later fix
    #1568 #1 there.
- **Scrolling by hand with find open (#1870):** today every DOM change while find is
  open recomputes and scrolls back to the active match. Measured in Changes: scroll
  to block 6 and the view snaps back to the match in block 1. Windowing would make
  that happen on every chunk draw. Change in `useDomFind`:
  - `search`, `next` and `prev` start a jump: a "jump pending" flag.
  - `render` scrolls only while a jump is pending.
  - The jump ends at the first of these:
    - the active range has a real box (on screen already, or just scrolled to);
    - there are no matches;
    - the user's own `wheel`, `pointerdown` or `keydown` reaches the find root (they
      took over the scroll). The find bar is outside that root (`WorkbenchFind` is
      rendered after `.wb-body`, `WorkbenchPane.tsx`), so Enter or a click on the
      bar's arrows does not end the jump it starts;
    - a backstop: the 8th scroll that actually moved `scrollTop`. A scroll that
      leaves `scrollTop` unchanged is not counted, so in Changes (which does not
      handle `find-reveal`) repeated scrolls to the same empty block box while
      neighbours draw do not use up the jump before the block draws.
  - A recompute caused by a DOM change repaints the highlights and the count, and
    scrolls only while a jump is pending.

  **Why the loop ends:** a pending jump scrolls only when `scrollTop` moves, at
  most 8 times, and then no DOM change scrolls again. A match that can never draw
  (inside a closed `<details>` in a Markdown preview) leaves `scrollTop` where the
  first scroll put it, so it adds no more. PLATFORM§25 records an observer feeding
  itself; the end rules are what stop it.
- **Cost:** mutation-driven recomputes are folded to one per animation frame, because
  ⌘A draws up to 16 chunks at once. On the stand-in, typing a 4,499-match query and
  then drawing one more chunk gave no long task over 50 ms.

### Copy (⌘A, ⌘C, drag-select)

Copy stays the browser's own. Windowing only makes sure the rows a selection covers
are in the DOM before ⌘C runs.

- **Drag inside what is drawn:** native, unchanged.
- **Drag that auto-scrolls:** chunks enter the lead-in and draw, and the selection
  keeps them drawn.
- **⌘A, or a shift-click after a far scroll:** the selection spans undrawn chunks,
  and `selectionchange` draws them all (above).
  - Measured on the stand-in: right after ⌘A, `Selection.toString()` held only the
    drawn rows (58,887 of 360,722 characters).
  - Once the hidden chunks were swapped back for their rows, it equaled the whole
    diff, character for character.
  - The selection's end sat at offset 0 of a chunk box both before and after the
    swap. Why that did not cut off the last chunk is not understood. Also, the
    stand-in swapped nodes by hand, not through React. So an e2e case pins the
    outcome ("⌘A text equals the whole diff"). It polls after
    `webContents.selectAll()`, because `selectionchange` arrives a task later.
- **Rejected: a `copy` handler that builds the text from the diff data.**
  - It would have to copy the browser's text rules: the gutter left out
    (`user-select: none`), line breaks between rows, and spaces (PLATFORM§68).
  - Native copy also writes a rich-text (`text/html`) form (inferred, not checked).
    The handler would drop it or have to rebuild it, so a paste into a rich editor
    could change.
  - Drawing the covered rows keeps the clipboard as it is today. The price is one
    full draw on ⌘A (~150 ms, inferred from the two ~150 ms renders at open; not
    measured).

### Other users of row positions

- **Go to line (`line` prop, file tab):** today it is `querySelector` on
  `[data-newno]` in an effect. After: the chunk holding `line` is part of the drawn
  set during render (derived from `line` and `parsed.rows`). The effect that
  scrolls to it reruns on `line`, on colors arriving (as today) and on "width known,
  boxes in". Opening a file at a line is the case with no known width yet, so the
  first commit draws no boxes; the next commit draws them, and that commit's
  effect finds the row and calls `scrollIntoView` as today. No `flushSync` (it
  would do nothing inside an effect). One jump.
- **Scroll restore (`ArtifactPane`):** see Heights. Measured heights come back from
  the cache, so the layout matches the one the saved `scrollTop` was taken from.
  - Every chunk box exists from the first render, so the full height is there at
    once, and the restore normally finishes on its first try, as today.
  - If the file got shorter while the tab was away, the existing "as far down as it
    now goes" path applies unchanged.
- **A change on disk:** new `parsed` → new chunks. The drawn set is kept by chunk
  number, so the same area stays drawn, and only those rows re-render. Chunks whose
  text did not change keep their measured heights (the cache is keyed by text).

## Where it applies

| Host                                        | Who scrolls                                | Windowed?                                                                                                     |
| ------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| File tab, Diff view (`ArtifactPane`)        | `.idiff` itself                            | yes                                                                                                           |
| Editor "On disk vs. yours" (`EditPane`)     | `.idiff` itself (`.ed-conflict-body > *`)  | yes                                                                                                           |
| Changes, one block per file (`ChangesView`) | the stream, not `.idiff`                   | no: Changes already draws whole files only near the screen, and folds a file over 2,000 diff lines behind a button |

`InlineDiff` gets a `windowed` prop, which `ArtifactPane` and `EditPane` set. Changes
keeps its own scheme. A 4,500-row file opened there with the "big diff" button still
draws whole, as today: one ~0.3 s pause after a click (Out of scope).

## Files

- `src/renderer/src/components/InlineDiff.tsx`: chunks, the drawn set, the scroll,
  resize, selection and `find-reveal` listeners, go to line.
- `src/renderer/src/components/diffWindow.ts` (new, no DOM): word packing into
  lines, chunk heights and running totals, which chunks a scroll range covers, the
  find text of a chunk, the measured-height cache.
- `src/renderer/src/inlineDiff.css`: `.idiff-chunk` (a plain block; an undrawn one
  gets its height inline).
- `src/renderer/src/useDomFind.ts`: the jump with its count of scrolls (#1870),
  `find-reveal`, one recompute per frame.
- `src/renderer/src/components/ArtifactPane.tsx`, `EditPane.tsx`: pass `windowed`.

## Tests

- **Unit, `diffWindow.test.ts`:**
  - word packing (a plain row, a long word, a tab, CJK, an empty row);
  - the chunks a scroll range covers, at the edges;
  - a chunk's find text equals the DOM text of the same rows drawn, before and after
    colors;
  - a cache hit needs the same text and the same width.
- **Unit, the `useDomFind` jump:**
  - a DOM change during a pending jump scrolls;
  - after the jump ends, a DOM change does not scroll;
  - a wheel event ends the jump;
  - a query with no match leaves no jump pending;
  - a match that never gets a box stops scrolling once `scrollTop` stops moving.
- **E2E, `preview.spec.ts`** (the file-tab diff flow), long-diff cases:
  - opening draws fewer than 1,000 rows;
  - the ⌘F count equals the full count, and Enter to a far match leaves the match
    on screen, with its row drawn;
  - with find open, scrolling away by hand stays put;
  - ⌘A text equals the whole diff;
  - click row N, scroll to the end, shift-click: the selection starts at row N;
  - go to line lands on a row in a chunk that was not drawn;
  - Diff → Source → Diff comes back at the same row. The fixture rows must wrap and
    the case must scroll through several chunks first; with one-line rows the
    estimate equals the measured height and the case would pass for free;
  - a row on screen stays put when a chunk above it draws.
- **E2E, `workbench-changes.spec.ts`:** #1870 (find open, scroll to block 6, the
  view stays).
- **E2E, `file-edit-save.spec.ts`:** the "On disk vs. yours" panel with a long diff
  shows the changed rows, and ⌘F finds a far one.
- **Specs to rerun:**
  - `preview.spec.ts`, `workbench-changes.spec.ts` and `file-edit-save.spec.ts`;
  - `keys.spec.ts` and `tab-switch.spec.ts` (find);
  - `md-preview-main.spec.ts` and `md-preview-corner.spec.ts` (`useDomFind` is
    shared).

## Each kind of session tab

The diff is drawn in the renderer from a `ParsedDiff`, whichever agent made the
change. Claude Code, Codex, Muse Code and Antigravity, local or remote: all eight the
same. On a remote tab the diff text (and the editor's on-disk text) first comes over
ssh, but once it reaches `InlineDiff` it is the same data, so nothing here changes
for remote.

## Risks

- **Estimate off for a chunk never drawn:** the probe's totals were off by 0.1–0.6%,
  but one chunk can be off by more (no per-chunk bound was measured). The error
  moves the scrollbar thumb when the chunk draws. It never moves a ⌘F or
  go-to-line landing, because those draw first.
- **Fonts loading late:** character widths measured before the mono font loads are
  wrong. Measure after `document.fonts.ready`, and again when a font finishes
  loading (PLATFORM§66).
- **⌘A on a 4,500-row diff:** costs one full draw (~150 ms). While the selection
  holds, a width change is as slow as today.
- **The #1870 fix on other ⌘F screens (not probed yet):** the row "the view stays on a
  change on disk" assumes each screen keeps its own `scrollTop` when its DOM is
  rebuilt. PLATFORM§25 records a rebuild that reset the scroll, and today the find
  observer's re-scroll would hide such a reset while ⌘F is open. The build reruns
  the Markdown and source reload cases with ⌘F open.

## Out of scope

- Changes blocks keep drawing whole (see "Where it applies"). Its other edges stay
  in #1568.
- `MAX_INLINE_ROWS` (5,000) stays. Windowing could lift it, but that is a separate
  change.
- **Inferred, not checked:**
  - native copy writes `text/html`;
  - the ⌘A cost of ~150 ms;
  - scroll anchoring keeps the view still when a chunk above changes height;
  - the After open cost on the built design (the first build step measures it);
  - the `find-reveal` jump landing in one step;
  - how long the fast-thumb strip lasts (bounded only by the stand-in's chunk draw,
    under 50 ms).
