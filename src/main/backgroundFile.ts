import fs from 'fs'

export class BackgroundFile {
  private latest = ''
  private latestGen = 0
  private savedGen = 0
  private writing = false

  constructor(private readonly file: () => string) {}

  write(text: string): void {
    this.latest = text
    this.latestGen++
    if (!this.writing) void this.drain()
  }

  flushSync(): void {
    if (this.savedGen >= this.latestGen) return
    const target = this.file()
    const tmp = `${target}.koloft-${process.pid}-now`
    try {
      fs.writeFileSync(tmp, this.latest)
      fs.renameSync(tmp, target)
    } catch {}
    this.savedGen = this.latestGen
  }

  private async drain(): Promise<void> {
    this.writing = true
    while (this.savedGen < this.latestGen) {
      const gen = this.latestGen
      const target = this.file()
      const tmp = `${target}.koloft-${process.pid}`
      try {
        await fs.promises.writeFile(tmp, this.latest)
        if (gen > this.savedGen) fs.renameSync(tmp, target)
        else await fs.promises.rm(tmp, { force: true })
      } catch {}
      this.savedGen = Math.max(this.savedGen, gen)
    }
    this.writing = false
  }
}
