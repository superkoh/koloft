import { describe, expect, it } from 'vitest'
import { TreeRemovals } from '../../src/main/treeRemovals'

const A = '/repo/.claude/worktrees/a'
const B = '/repo/.claude/worktrees/b'

describe('TreeRemovals', () => {
  it('a close check and a second removal of one worktree wait until the removal already deleting it ends, a check with a time limit gives up once it passes, also from a folder inside it, and another worktree waits for nothing', async () => {
    const r = new TreeRemovals()
    const order: string[] = []
    let finishSweep = (): void => {}
    const sweepHolds = new Promise<void>((resolve) => (finishSweep = resolve))
    const sweep = r.run(A, async () => {
      order.push('sweep starts')
      await sweepHolds
      order.push('sweep ends')
    })
    const check = r.settled(A).then(() => order.push('check reads'))
    const close = r.run(A, async () => {
      order.push('close removes')
    })
    await r.settled(B)
    order.push('other worktree')
    expect(await r.settledWithin(A, 20)).toBe(false)
    expect(await r.settledWithin(`${A}/src`, 20)).toBe(false)
    expect(await r.settledWithin(B, 20)).toBe(true)
    finishSweep()
    await Promise.all([sweep, check, close])
    expect(order).toEqual([
      'sweep starts',
      'other worktree',
      'sweep ends',
      'check reads',
      'close removes'
    ])
    expect(r.has(A)).toBe(false)
    expect(await r.settledWithin(A, 20)).toBe(true)
  })

  it('a removal that fails lets the next one run', async () => {
    const r = new TreeRemovals()
    await expect(
      r.run(A, async () => {
        throw new Error('could not remove it')
      })
    ).rejects.toThrow('could not remove it')
    expect(await r.run(A, async () => 'removed')).toBe('removed')
  })
})
