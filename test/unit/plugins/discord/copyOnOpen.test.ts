import { describe, expect, it } from 'vitest'
import { moment, type FileOpened } from '../../../../src/core/moment'
import { copyEachOpenedFile } from '../../../../src/plugins/discord/main/copyOnOpen'

const opened = { tabId: 't1', target: '/w/plan.md' }

function saidWhenOpened(copyToPhone: (o: FileOpened) => Promise<string | undefined>) {
  const fileOpened = moment<FileOpened>()
  copyEachOpenedFile(fileOpened, copyToPhone)
  return fileOpened.announce(opened)
}

describe('Discord copies each file a session opens', () => {
  it('the reply carries what the copy said', async () => {
    expect(await saidWhenOpened(async () => 'Sent the file to Discord.')).toEqual([
      'Sent the file to Discord.'
    ])
  })

  it('a copy that fails says why in the reply instead of failing the open', async () => {
    const said = await saidWhenOpened(async () => {
      throw new Error('the bot is offline.')
    })
    expect(said).toEqual(['Koloft could not also send it to Discord: the bot is offline.'])
  })
})
