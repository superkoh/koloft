import path from 'path'
import { realpathSafe } from './projectInfo'

function keyOf(tree: string): string {
  return `${realpathSafe(path.dirname(tree))}/${path.basename(tree)}`
}

export class TreeRemovals {
  private running = new Map<string, Promise<unknown>>()

  has(tree: string): boolean {
    return this.running.has(keyOf(tree))
  }

  async settled(tree: string): Promise<void> {
    const key = keyOf(tree)
    while (this.running.has(key)) await this.running.get(key)?.catch(() => undefined)
  }

  async settledWithin(tree: string, ms: number): Promise<boolean> {
    const key = keyOf(tree)
    const deadline = Date.now() + ms
    while (this.running.has(key)) {
      const left = deadline - Date.now()
      if (left <= 0) return false
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        this.running.get(key)?.catch(() => undefined),
        new Promise<void>((resolve) => (timer = setTimeout(resolve, left)))
      ])
      clearTimeout(timer)
    }
    return true
  }

  async run<T>(tree: string, work: () => Promise<T>): Promise<T> {
    const key = keyOf(tree)
    while (this.running.has(key)) await this.running.get(key)?.catch(() => undefined)
    const done = Promise.resolve().then(work)
    this.running.set(key, done)
    try {
      return await done
    } finally {
      if (this.running.get(key) === done) this.running.delete(key)
    }
  }
}
