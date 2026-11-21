import fs from 'fs'

export class LineTail {
  private rest = ''

  constructor(
    readonly file: string,
    private onLine: (line: string) => void,
    private offset = 0
  ) {}

  read(): void {
    if ((fs.statSync(this.file, { throwIfNoEntry: false })?.size ?? 0) <= this.offset) return
    let fd: number
    try {
      fd = fs.openSync(this.file, 'r')
    } catch {
      return
    }
    try {
      const size = fs.fstatSync(fd).size
      if (size <= this.offset) return
      const buf = Buffer.alloc(size - this.offset)
      fs.readSync(fd, buf, 0, buf.length, this.offset)
      this.offset = size
      const lines = (this.rest + buf.toString('utf8')).split('\n')
      this.rest = lines.pop() ?? ''
      for (const line of lines) if (line) this.onLine(line)
    } finally {
      fs.closeSync(fd)
    }
  }
}
