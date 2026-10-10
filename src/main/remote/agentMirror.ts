import fs from 'fs'
import { REQUEST_NAME } from '../agentRequests'
import { watchAndSweepJsonDrops } from '../jsonDrops'

export const AGENT_DROP_NAME = /^(req|res)-[A-Za-z0-9-]+\.json$/

const FORGET_A_REQUEST_THE_MIRROR_DROPPED_MS = 1000

// PLATFORM§34
export function watchMirroredAgentRequests(
  dir: string,
  answer: (requestId: string, raw: unknown) => void
): () => void {
  const answered = new Set<string>()
  const watcher = watchAndSweepJsonDrops(dir, (name) => {
    const id = REQUEST_NAME.exec(name)?.[1]
    if (!id || answered.has(name)) return null
    return (raw): void => {
      if (answered.has(name)) return
      answered.add(name)
      answer(id, raw)
    }
  })
  const forget = setInterval(() => {
    fs.readdir(dir, (err, names) => {
      if (err) return
      const present = new Set(names)
      for (const name of answered) if (!present.has(name)) answered.delete(name)
    })
  }, FORGET_A_REQUEST_THE_MIRROR_DROPPED_MS).unref()
  return () => {
    watcher?.close()
    clearInterval(forget)
  }
}
