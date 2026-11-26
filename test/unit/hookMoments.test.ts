import { describe, expect, it } from 'vitest'
import {
  isAnOpeningRule,
  messageArrivesRules,
  textOf,
  turnAboutToEndRules
} from '../../src/core/hookMoments'

describe("the hook-moment rules every agent's hook script is built from", () => {
  it('no opening is the start of another, since the first arm a message matches is the only one that runs', () => {
    const openings = messageArrivesRules().filter(isAnOpeningRule).map(textOf)
    const hidden = openings.filter((o) =>
      openings.some((other) => other !== o && o.startsWith(other))
    )
    expect(hidden).toEqual([])
  })

  it('all plugins together have at most one turn-about-to-end rule, since the once-per-turn mark is one file per tab', () => {
    expect(turnAboutToEndRules().length).toBeLessThanOrEqual(1)
  })
})
