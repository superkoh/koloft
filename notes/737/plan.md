# Plan: draw only the part of a long inline diff that is near the screen (#737, item 3)

**In one line:** when you open a long diff (more than 1,000 rows) in a file tab or in
the editor's "On disk vs. yours" panel, Koloft draws only the rows near the screen.
⌘F, ⌘A, ⌘C and drag-select work exactly as they do today.

## The picture

```
 .idiff  (the box that scrolls)
 ┌──────────────────────────────────────────┐
 │ chunk 0   rows 1–250      drawn          │  ← lead-in: one screen above
 │ chunk 1   rows 251–500    drawn          │  ← on screen
 │ chunk 2   rows 501–750    drawn          │  ← lead-in: one screen below
 │ chunk 3   rows 751–1000   NOT drawn ─────┼─ an empty box of the right height,
 │ …                                        │  holding one hidden text node with
 │ chunk 17  rows 4251–4500  NOT drawn      │  the chunk's code (for ⌘F)
 └──────────────────────────────────────────┘
```

A chunk is 250 rows. A chunk is drawn when (a) it is on screen or within one screen
of it, or (b) the current selection touches it, or (c) a find jump or a "go to line"
is landing in it. Every other chunk is an empty box that is as tall as its rows would
be and holds their text in a `hidden` element. A diff of up to 1,000 rows is drawn
whole, the same way as today.

This is the same shape Changes already uses for whole files (`UndrawnRows` in
`ChangesView.tsx`, PLATFORM§24, test WB-C16), applied to rows inside one diff.

## Is it still worth doing? (measured 2026-11-13 on `main` 668a5d18)

All numbers are from the hidden e2e window, where frames do run. The diff is 4,500
rows: a 4,000-line file with 500 lines changed. "After" was measured on the same
diff with chunks 2–17 swapped by hand for hidden-text boxes (`windowing.probe.ts`),
and on a 562-row diff, which is about what the windowed diff draws at once.

| What                                      | Today (4,500 rows drawn)   | After (about 500 drawn)    |
| ----------------------------------------- | -------------------------- | -------------------------- |
| Open the diff: long tasks                 | 300–308 ms (two ~150 ms)   | none over 50 ms (562 rows) |
| Width step (4 px), forced relayout        | 34–74 ms, mostly ~40 ms    | 3.7–6.5 ms                 |
| Full relayout (font size)                 | 193 ms                     | not measured               |
| A change on disk                          | 155–183 ms                 | not measured (≈ open)      |
| Type a ⌘F query with 4,500 matches        | 125–264 ms                 | none over 50 ms            |
| ⌘F open, one more chunk draws             | (nothing draws today)      | none over 50 ms            |

The October numbers in the issue (0.9–1.1 s to open) are now about 0.3 s, because
coloring moved to a worker (#1569, #1585). What is left is two React renders of every
row. During a Workbench divider drag, a width step happens about once per frame, and
~40 ms per step is what makes the drag stutter. So it is still worth doing.

## What a user sees change

| Case                                              | Today                                  | After                                                                  |
| ------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------- |
| Open a 4,500-row diff                             | ~0.3 s freeze                          | no freeze                                                              |
| Drag the Workbench divider with that diff open    | ~40 ms per step (stutters)             | ~5 ms per step                                                         |
| ⌘F: count, order, Enter / ⇧Enter                  | all matches, in order                  | the same (measured: 4,499 = 4,499)                                     |
| ⌘F: jump to a match far below                     | one jump                               | one jump, then a short correction once its rows draw (see Find)        |
| ⌘F open, then scroll away by hand                 | stays where you scroll                 | the same (needs the #1870 fix, below)                                  |
| ⌘A then ⌘C                                        | the whole diff                         | the same text; the first ⌘A draws every row (~150 ms, inferred)        |
| Drag-select across many rows, then ⌘C             | what you dragged over                  | the same                                                               |
| Shift-click after a fast scroll, then ⌘C          | everything in between                  | the same (the rows in between are drawn as the selection grows)        |
| Drag the scrollbar thumb very fast                | rows always there                      | an empty strip may show for about one frame (as in Changes, #1568 #4)  |
| Diffs of up to 1,000 rows                         | —                                      | no change at all (same DOM as today)                                   |

None of these is a product choice. The fast-thumb strip is the cost windowing always
has. Changes already ships it, and #1568 tracks it there. The one-screen lead-in
covers wheel and trackpad scrolling.

## How each part works

### Which chunks are drawn

- `InlineDiff` splits `shown` (the rows it draws today, up to `MAX_INLINE_ROWS`) into
  chunks of 250 rows. It does this only when there are more than 1,000 rows.
- **Height of a chunk that is not drawn:** the sum of each row's height, worked out
  from its text. Wrapped lines = `ceil(text columns / columns that fit)`, where
  "columns that fit" comes from the code column's width and the width of one
  character of the mono font (canvas `measureText`). A tab counts up to the next stop
  of 8 columns, and a wide (CJK) character counts 2. Measured on the 4,500-row
  fixture at 432 px: the estimate matched every one of the 4,500 rows (179,980 px
  both ways). After a chunk draws, its real `offsetHeight` replaces the estimate. A
  width change (ResizeObserver on `.idiff`) throws the measured heights away, and
  every chunk goes back to the estimate until it draws again.
- **Picking the chunks:** a `scroll` listener on `.idiff` and the ResizeObserver work
  out which chunks fall within one screen of the view, using running totals of chunk
  heights. Those chunks become the drawn set (React state). Two reasons for a scroll
  listener rather than an IntersectionObserver: it runs before the frame paints, and
  it gives exact chunk numbers.
- **Selection keeps chunks drawn:** on `selectionchange`, if the selection is not
  collapsed and touches this diff, every chunk from the one holding its start to the
  one holding its end is drawn. An end before or after the diff counts as the first
  or last chunk. The draw uses `flushSync`, so a ⌘C pressed right after is handled
  only once the rows are in the DOM. Changes keeps a selected block drawn the same
  way (`stays` in `markVisible`).
- **Colored rows:** the colored HTML per row (`rowHtmlObjs`) stays computed for every
  row, as today. A drawn chunk takes its rows' objects by index, so the
  `dangerouslySetInnerHTML` wrapper objects stay the same, and drawing a chunk again
  does not rebuild a row whose HTML did not change (PLATFORM§25).

### Find (⌘F)

Find keeps reading the DOM (`useDomFind.ts`). The text of rows that are not drawn is
put into the DOM from the diff data, as one hidden text node per chunk.

- **Count and order:** the hidden text of a chunk is its rows' code joined with
  nothing in between. A TreeWalker over drawn rows sees exactly that (the gutter
  number and sign are already skipped by `DIFF_GUTTER_NOT_FILE_CONTENT`). One helper
  makes both forms, so an empty row is the same character in both (`' '` before
  colors land, `' '` after). Measured: `value_` gave 4,499 matches with 4,000 of
  the 4,500 rows hidden, the same as fully drawn.
- **Highlight:** drawn rows show it as today. Hidden ranges have no box and paint
  nothing, and they are off screen anyway.
- **Jump to the Nth match (typing, Enter, ⇧Enter, the arrows):** the active range
  sits in hidden text, so `shownBoxOf` finds the chunk's box. Measured: the jump
  scrolled the chunk on screen. That draws the chunk, the MutationObserver
  recomputes, and the jump then lands on the exact match.
  - Change: when the range is inside a `[hidden]` element, `useDomFind` scrolls to
    the point in the box that matches the range's place in the hidden text (offset
    ÷ length × box height), not to the middle of the box. The first jump then lands
    within a few rows, and the correction is small. This also fixes #1568 #1 for
    Changes.
- **Scrolling by hand with find open (#1870):** today every DOM change while find is
  open recomputes and scrolls back to the active match. Measured in Changes: scroll
  to block 6 and it snaps back to the match in block 1. Windowing would make that
  happen on every chunk draw. Change in `useDomFind`:
  - `search`, `next` and `prev` set a "jump pending" flag.
  - `render` scrolls only while that flag is set, and clears it once the active
    range has a real box (not the hidden fallback) and has been scrolled to.
  - A recompute caused by a DOM change repaints the highlights and the count, and
    scrolls only if a jump is still pending.

  **Why the loop ends:** a pending jump causes at most two scrolls, one to the chunk
  box and one to the exact range. After that no mutation scrolls again. PLATFORM§25
  records an observer feeding itself; this flag is what stops it.
- **Cost:** with a 4,499-match query on the hand-windowed diff, typing it and then
  drawing one more chunk gave no long task over 50 ms. Mutation-driven recomputes
  are also folded to one per animation frame, because a ⌘A draws 16 chunks in one go.

### Copy (⌘A, ⌘C, drag-select)

Copy stays the browser's own. Windowing only makes sure the rows a selection covers
are in the DOM before ⌘C runs.

- **Drag inside what is drawn:** native, unchanged.
- **Drag that auto-scrolls:** chunks enter the lead-in and draw. The selection then
  keeps them drawn.
- **⌘A, or shift-click after a fast scroll:** the selection covers chunks that are
  not drawn. `selectionchange` draws them all (above). Measured on the hand-windowed
  diff: right after ⌘A, `Selection.toString()` held only the drawn rows (58,887 of
  360,722 characters). Once the hidden chunks were swapped back for their rows, it
  equaled the whole diff, character for character. The selection's end point sat at
  offset 0 of a chunk box before and after the swap. Why that did not cut off the
  last chunk is not understood, so an e2e case pins the outcome ("⌘A text equals the
  whole diff").
- **Rejected: a `copy` handler that builds the text from the diff data.**
  - It would have to copy the browser's rules for the text: the gutter left out
    (`user-select: none`), a line break between rows, and spaces (PLATFORM§68).
  - Native copy also writes a rich-text (`text/html`) form (inferred, not checked).
    The handler would drop it or have to rebuild it, so a paste into a rich editor
    could change.
  - Drawing the covered rows keeps the clipboard as it is today. The price is one
    full draw on ⌘A (~150 ms, inferred from the two ~150 ms renders at open; not
    measured), the same work today's open already pays.

### Other users of row positions

- **Go to line (`line` prop, file tab):** today it is `querySelector` on
  `[data-newno]`. After: find the row index in `parsed.rows`, mark its chunk as
  landing (drawn), and after that commit `scrollIntoView` the row as today.
- **Scroll restore on a view switch (`ArtifactPane`, `scrollTop === want`):** the
  estimated total height equals the real one when the estimate is right (measured
  exact on the fixture), so the restore lands as today. If the estimate is short,
  `scrollTop` clamps. The restore then retries on each mutation until
  `GIVE_UP_RESTORE_MS`, as today, and chunk draws grow the height toward `want`.
- **Rows above the view changing height** (estimate → measured): Chromium's scroll
  anchoring (`overflow-anchor: auto`, the default) keeps the rows on screen in place
  (inferred, not checked; an e2e case checks it).
- **A change on disk:** new `parsed` → new chunks. The drawn set is kept by chunk
  number, so the same area stays drawn, and only those rows re-render.

## Where it applies

| Host                                         | Who scrolls                                  | Windowed?                                                                 |
| -------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------- |
| File tab, Diff view (`ArtifactPane`)         | `.idiff` itself                              | yes                                                                       |
| Editor "On disk vs. yours" (`EditPane`)      | `.idiff` itself (`.ed-conflict-body > *`)    | yes                                                                       |
| Changes, one block per file (`ChangesView`)  | the stream, not `.idiff`                     | no: Changes already draws whole files only near the screen, and folds a file over 2,000 diff lines behind a button |

`InlineDiff` gets a `windowed` prop, which `ArtifactPane` and `EditPane` set. Changes
keeps its own scheme. A 4,500-row file opened there with the "big diff" button still
draws whole, as today: one ~0.3 s pause after a click. That is listed under Out of
scope.

## Files

- `src/renderer/src/components/InlineDiff.tsx`: chunks, drawn set, scroll, resize
  and selection listeners, go to line.
- `src/renderer/src/components/diffWindow.ts` (new, no DOM): row height from text,
  chunk heights, which chunks a scroll range covers, the find text of a chunk.
- `src/renderer/src/inlineDiff.css`: `.idiff-chunk` (plain block; an undrawn one
  gets its height inline).
- `src/renderer/src/useDomFind.ts`: the "jump pending" flag (#1870), one recompute per
  frame, the in-proportion landing in hidden text (#1568 #1).
- `src/renderer/src/components/ArtifactPane.tsx`, `EditPane.tsx`: pass `windowed`.
- `src/renderer/src/components/ChangesView.tsx`: `UndrawnRows` uses the shared
  find-text helper (only if the result is shorter; otherwise left alone).

## Tests

- **Unit, `diffWindow.test.ts`:** wrapped row height (plain, tab, wide character,
  empty row); chunks covered by a scroll range at the edges; the find text of a
  chunk equals the DOM text of the same rows drawn.
- **E2E, `preview.spec.ts`** (the file-tab diff flow), one long-diff case each:
  - opening draws fewer than 1,000 rows;
  - ⌘F count equals the full count, and Enter to a far match draws its row with the
    match on screen;
  - with find open, scrolling away by hand stays put;
  - ⌘A (`webContents.selectAll`) text equals the whole diff;
  - go to line lands on a row in a chunk that is not drawn;
  - a row on screen stays put when a chunk above it draws.
- **E2E, `workbench-changes.spec.ts`:** #1870 (find open, scroll to block 6, the
  view stays).
- **E2E, `file-edit-save.spec.ts`:** the "On disk vs. yours" panel with a long diff
  still shows the changed rows.
- **Specs to rerun:** `preview.spec.ts`, `workbench-changes.spec.ts`,
  `file-edit-save.spec.ts`, `keys.spec.ts` and `tab-switch.spec.ts` (find), and
  `md-preview-main.spec.ts` (`useDomFind` is shared).

## Each kind of session tab

The diff is drawn in the renderer from a `ParsedDiff`, whoever made the change.
Claude Code, Codex, Muse Code and Antigravity, local or remote: all eight the same. On
a remote tab the diff text (and the editor's on-disk text) comes over ssh first, but
once it reaches `InlineDiff` it is the same data, so nothing here changes for remote.

## Risks

- **Word wrap at word boundaries:** `pre-wrap` breaks at spaces, so a row with long
  words can wrap one line more than the column count says. Only an undrawn chunk's
  height is off, and only until it draws. Scroll anchoring keeps the view still.
- **Fonts loading late:** a character width measured before the mono font loads is
  wrong. Measure after `document.fonts.ready`, and again on the font's `loadingdone`
  event (PLATFORM§66).
- **⌘A on a 4,500-row diff** costs one full draw (~150 ms) while the selection holds,
  and a width change during it is as slow as today.

## Out of scope

- Changes blocks keep drawing whole (see "Where it applies"). Its other edges stay in
  #1568.
- `MAX_INLINE_ROWS` (5,000) stays. Windowing could lift it, but that is a separate
  change.
- Inferred, not checked: native copy writes `text/html`. The ⌘A cost of ~150 ms.
  Scroll anchoring keeping the view still when a chunk above changes height.
