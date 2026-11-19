import { describe, expect, it } from 'vitest'
import { INSTRUCTIONS_CHANGED, Moments } from '../../../../src/core/moment'
import { PLUGINS } from '../../../../src/plugins/list'
import {
  SEE_OR_UNDO_IT_IN_KOLOFT,
  tellThePhoneOfInstructionChanges
} from '../../../../src/plugins/discord/main/instructionsNews'

describe('an agent’s change to the owner’s instructions, on Discord', () => {
  it('sends the same notice to the owner’s channel, saying it can be seen and undone in Koloft', async () => {
    const moments = new Moments(PLUGINS)
    const sent: string[] = []
    tellThePhoneOfInstructionChanges(moments, async (text) => {
      sent.push(text)
      return true
    })
    expect(
      await moments.announce(INSTRUCTIONS_CHANGED, 'Alfred changed its instructions.')
    ).toEqual([])
    expect(sent).toEqual([`Alfred changed its instructions. ${SEE_OR_UNDO_IT_IN_KOLOFT}`])
  })

  it('tells the agent when Discord could not take it, and the change still stands', async () => {
    const moments = new Moments(PLUGINS)
    tellThePhoneOfInstructionChanges(moments, () => Promise.reject(new Error('offline')))
    expect(await moments.announce(INSTRUCTIONS_CHANGED, 'x')).toEqual([
      'Koloft could not also tell the owner on Discord: offline'
    ])
  })
})
