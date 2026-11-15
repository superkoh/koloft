import path from 'path'
import { realpathSafe } from './projectInfo'
import { within } from './within'

function keyOf(dir: string): string {
  return `${realpathSafe(path.dirname(dir))}/${path.basename(dir)}`
}

export class TreeRemovals {
  private running = new Map<string, Promise<unknown>>()

  private removalHolding(key: string): Promise<unknown> | undefined {
    for (const [tree, removal] of this.running)
      if (key === tree || key.startsWith(`${tree}/`)) return removal
    return undefined
  }

  has(dir: string): boolean {
    return !!this.removalHolding(keyOf(dir))
  }

  async settled(dir: string): Promise<void> {
    const key = keyOf(dir)
    for (let r = this.removalHolding(key); r; r = this.removalHolding(key))
      await r.catch(() => undefined)
  }

  settledWithin(dir: string, ms: number): Promise<boolean> {
    return within(this.settled(dir), ms, dir).then(
      () => true,
      () => false
    )
  }

  async run<T>(tree: string, work: () => Promise<T>): Promise<T> {
    const key = keyOf(tree)
    for (let r = this.removalHolding(key); r; r = this.removalHolding(key))
      await r.catch(() => undefined)
    const done = Promise.resolve().then(work)
    this.running.set(key, done)
    try {
      return await done
    } finally {
      this.running.delete(key)
    }
  }
}
