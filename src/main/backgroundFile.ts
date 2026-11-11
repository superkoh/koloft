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

const SAME_FILE_SO_THE_MOVE_IN_FLIGHT_CARRIES_THE_NEWEST_TEXT = ''

export class BackgroundFile {
  private static readonly draining = new Set<Promise<void>>()

  static async whenAllWritten(): Promise<void> {
    while (BackgroundFile.draining.size) await Promise.all(BackgroundFile.draining)
  }

  private latest = ''
  private latestGen = 0
  private savedGen = 0
  private writing = false
  private movingIntoPlace = false

  constructor(
    private readonly file: () => string,
    private readonly mode?: number
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
    const tmp = halfWrittenFileOf(
      target,
      this.movingIntoPlace ? SAME_FILE_SO_THE_MOVE_IN_FLIGHT_CARRIES_THE_NEWEST_TEXT : '-now'
    )
    try {
      fs.mkdirSync(path.dirname(tmp), { recursive: true })
      fs.writeFileSync(tmp, this.latest, { mode: this.mode })
      fs.renameSync(tmp, target)
    } catch {}
    this.savedGen = this.latestGen
  }

  private async drain(): Promise<void> {
    this.writing = true
    while (this.savedGen < this.latestGen) {
      const gen = this.latestGen
      const target = this.file()
      const tmp = halfWrittenFileOf(target)
      try {
        await fs.promises.mkdir(path.dirname(tmp), { recursive: true })
        await fs.promises.writeFile(tmp, this.latest, { mode: this.mode })
        if (gen > this.savedGen) {
          this.movingIntoPlace = true
          await fs.promises.rename(tmp, target)
        } else await fs.promises.rm(tmp, { force: true })
      } catch {}
      this.movingIntoPlace = false
      this.savedGen = Math.max(this.savedGen, gen)
    }
    this.writing = false
  }
}
