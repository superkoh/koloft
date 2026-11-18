import { describe, expect, it } from 'vitest'
import { moment } from '../../src/core/moment'

describe('a moment', () => {
  it('announcing it hands every listener the moment and returns what they said in the order they listened, leaving out who said nothing', async () => {
    const heard: string[] = []
    const opened = moment<string>()
    opened.listen(async (m) => (heard.push(m), 'first'))
    opened.listen(async () => undefined)
    opened.listen(async () => '')
    opened.listen(async () => 'last')
    expect(await opened.announce('plan.md')).toEqual(['first', 'last'])
    expect(heard).toEqual(['plan.md'])
  })
})
