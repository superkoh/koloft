import { describe, it, expect } from 'vitest'
import { WORKBENCH_PANE_MIN } from '../../src/renderer/src/auxSurface'
import { paneWidthFromDrag } from '../../src/renderer/src/sessionRows'

/**
 * What survived the Workbench merge: the module holds ONE number now.
 *
 * `auxSurfaceOf` arbitrated which of two mutually-exclusive surfaces owned the aux
 * column — a question that stopped existing when the column became one tabbed panel — and
 * `auxPaneMin`'s per-surface floors collapsed with it: any tab can be a `web` tab now, so
 * the higher of the two inherited floors (the Browser's 440, not Preview's 320) is the
 * single floor. Both functions are gone; their suites went with them.
 */
describe('WORKBENCH_PANE_MIN (the panel’s one width floor, FR-08/NFR-07, WB-L07)', () => {
  it('is 440 — the Browser floor won the merge, not Preview’s 320', () => {
    expect(WORKBENCH_PANE_MIN).toBe(440)
  })

  it('the panel cannot be dragged below it (FR-08, WB-L07)', () => {
    expect(paneWidthFromDrag(1000, 100, 900, WORKBENCH_PANE_MIN)).toBe(440)
  })

  it('the TUI floor still outranks it (FR-08, WB-L08)', () => {
    // available = 900; ceiling = 900 − 380 = 520, whatever the panel is showing
    expect(paneWidthFromDrag(1000, 100, 200, WORKBENCH_PANE_MIN)).toBe(520)
  })
})
