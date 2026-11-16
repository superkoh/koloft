import fs from 'fs'
import path from 'path'

// PLATFORM§69
export const FOLDER_OF_HALF_WRITTEN_FILES = '.koloft-writes'

function halfWrittenFileOf(target: string, suffix = ''): string {
  return path.join(
    path.dirname(target),
    FOLDER_OF_HALF_WRITTEN_FILES,
    `${path.basename(target)}.${process.pid}${suffix}`
  )
}

function dropTheOlderSaveStillOnItsWayIn(target: string): void {
  try {
    fs.unlinkSync(halfWrittenFileOf(target))
  } catch {}
}

export class BackgroundFile {
  private static readonly draining = new Set<Promise<void>>()

  static async whenAllWritten(): Promise<void> {
    while (BackgroundFile.draining.size) await Promise.all(BackgroundFile.draining)
  }

  private latest = ''
  private latestGen = 0
  private savedGen = 0
  private writing = false
  private folderMadeFor: string | undefined

  constructor(
    private readonly file: () => string,
    private readonly mode?: number,
    private readonly gaveUp?: () => void
  ) {}

  write(text: string): void {
    this.latest = text
    this.latestGen++
    if (this.writing) return
    const drained = this.drain()
    BackgroundFile.draining.add(drained)
    void drained.then(() => BackgroundFile.draining.delete(drained))
  }

  flushSync(): void {
    if (this.savedGen >= this.latestGen) return
    const target = this.file()
    const tmp = halfWrittenFileOf(target, '-now')
    try {
      fs.mkdirSync(path.dirname(tmp), { recursive: true })
      fs.writeFileSync(tmp, this.latest, { mode: this.mode })
      dropTheOlderSaveStillOnItsWayIn(target)
      fs.renameSync(tmp, target)
    } catch {}
    this.savedGen = this.latestGen
  }

  private async drain(): Promise<void> {
    this.writing = true
    let genTriedAgain = 0
    while (this.savedGen < this.latestGen) {
      let gen = this.latestGen
      const target = this.file()
      const tmp = halfWrittenFileOf(target)
      try {
        if (this.folderMadeFor !== target) {
          await fs.promises.mkdir(path.dirname(tmp), { recursive: true })
          this.folderMadeFor = target
        }
        gen = this.latestGen
        await fs.promises.writeFile(tmp, this.latest, { mode: this.mode })
        if (gen > this.savedGen) await fs.promises.rename(tmp, target)
        else await fs.promises.rm(tmp, { force: true })
      } catch {
        this.folderMadeFor = undefined
        const theFolderMayBeGoneSoMakeItAndTryThisTextOnceMore = genTriedAgain !== gen
        genTriedAgain = gen
        if (theFolderMayBeGoneSoMakeItAndTryThisTextOnceMore) continue
        const noNewerTextWaits = gen === this.latestGen
        if (noNewerTextWaits) this.gaveUp?.()
      }
      this.savedGen = Math.max(this.savedGen, gen)
    }
    this.writing = false
  }
}
