import fs from 'fs'
import { mirrorHookDir } from './paths'

export function hookMirrorWatches(
  userData: () => string,
  remoteTargets: () => { host: string }[],
  watch: (dir: string, host: string) => () => void
): () => void {
  const watched = new Map<string, () => void>()
  return () => {
    const root = userData()
    const wanted = new Map(remoteTargets().map((t) => [mirrorHookDir(root, t.host), t.host]))
    for (const [dir, dispose] of watched) {
      if (wanted.has(dir)) continue
      dispose()
      watched.delete(dir)
    }
    for (const [dir, host] of wanted) {
      if (watched.has(dir)) continue
      try {
        fs.mkdirSync(dir, { recursive: true })
      } catch {}
      watched.set(dir, watch(dir, host))
    }
  }
}
