import { describe, it, expect } from 'vitest'
import { WORKBENCH_PANE_MIN } from '../../src/renderer/src/auxSurface'
import { paneWidthFromDrag } from '../../src/renderer/src/sessionRows'

describe('WORKBENCH_PANE_MIN (the panel’s one width floor, FR-08/NFR-07, WB-L07)', () => {
  it('is 440 — the Browser floor won the merge, not Preview’s 320', () => {
    expect(WORKBENCH_PANE_MIN).toBe(440)
  })

  it('the panel cannot be dragged below it (FR-08, WB-L07)', () => {
    expect(paneWidthFromDrag(1000, 100, 900, WORKBENCH_PANE_MIN)).toBe(440)
  })

  it('the TUI floor still outranks it (FR-08, WB-L08)', () => {
    expect(paneWidthFromDrag(1000, 100, 200, WORKBENCH_PANE_MIN)).toBe(520)
  })
})
