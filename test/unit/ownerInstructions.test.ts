import { describe, expect, it } from 'vitest'
import {
  OWNER,
  savedVersions,
  textInUse,
  versionsStore,
  type InstructionsVersion
} from '../../src/core/ownerInstructions'

const LIMIT = 100

const saved = (
  versions: InstructionsVersion[] | undefined,
  raw: string,
  at: number
): InstructionsVersion[] | undefined => {
  const result = savedVersions(versions, raw, OWNER, at, LIMIT)
  if (!result.ok) throw new Error(result.error)
  return result.versions
}

describe('saving a list of versions of the owner’s instructions', () => {
  it('keeps each change as a version, newest last, and the newest is the text in use', () => {
    const second = saved(saved(undefined, 'Answer in Chinese.', 1), 'Be brief.', 2)
    expect(second).toEqual([
      { text: 'Answer in Chinese.', at: 1, by: OWNER },
      { text: 'Be brief.', at: 2, by: OWNER }
    ])
    expect(textInUse(second)).toBe('Be brief.')
  })

  it('records no change when the text is the same once cleaned', () => {
    expect(saved(saved(undefined, 'Be brief.', 1), '  Be brief.\r\n', 2)).toBeUndefined()
  })

  it('drops characters that cannot be seen, keeps line breaks and tabs, and trims the ends', () => {
    expect(textInUse(saved(undefined, ' one\r\n\ttwo\u0007\u001b[0m ', 1))).toBe('one\n\ttwo[0m')
  })

  it('refuses text over the limit and says by how much', () => {
    expect(savedVersions(undefined, 'a'.repeat(LIMIT + 12), OWNER, 1, LIMIT)).toEqual({
      ok: false,
      error: 'The instructions are 12 over the limit.'
    })
  })

  it('keeps the last twenty versions', () => {
    let versions: InstructionsVersion[] | undefined
    for (let at = 1; at <= 25; at++) versions = saved(versions, `rule ${at}`, at)
    expect(versions?.map((v) => v.at)).toEqual(Array.from({ length: 20 }, (_, i) => i + 6))
  })

  it('an agent’s write that changes nothing saves nothing', async () => {
    const writes: InstructionsVersion[][] = []
    const store = versionsStore(
      () => undefined,
      (v) => writes.push(v),
      LIMIT,
      () => 1
    )
    expect(await store.writeIfStill('', '', 'Fix login')).toBe(true)
    expect(writes).toEqual([])
  })
})
