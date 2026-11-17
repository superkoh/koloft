import { describe, expect, it } from 'vitest'
import { copyEachOpenedFile } from '../../src/plugins/discord/main/copyOnOpen'

const opened = { tabId: 't1', target: '/w/plan.md' }

describe('Discord copies each file a session opens', () => {
  it('the reply carries what the copy said', async () => {
    const listener = copyEachOpenedFile(async () => 'Sent the file to Discord.')
    expect(await listener(opened)).toBe('Sent the file to Discord.')
  })

  it('a copy that fails says why in the reply instead of failing the open', async () => {
    const listener = copyEachOpenedFile(async () => {
      throw new Error('the bot is offline.')
    })
    expect(await listener(opened)).toBe(
      'Koloft could not also send it to Discord: the bot is offline.'
    )
  })
})
