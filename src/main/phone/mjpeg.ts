const HEADER_END = Buffer.from('\r\n\r\n')
const CONTENT_LENGTH = /content-length:\s*(\d+)/i

export class MjpegFrames {
  private buf: Buffer = Buffer.alloc(0)
  private need: number | null = null

  push(chunk: Buffer): Buffer[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    const frames: Buffer[] = []
    for (;;) {
      if (this.need === null) {
        const end = this.buf.indexOf(HEADER_END)
        if (end < 0) break
        const head = this.buf.subarray(0, end).toString('latin1')
        this.buf = this.buf.subarray(end + HEADER_END.length)
        const length = CONTENT_LENGTH.exec(head)?.[1]
        if (length) this.need = Number(length)
        continue
      }
      if (this.buf.length < this.need) break
      frames.push(Buffer.from(this.buf.subarray(0, this.need)))
      this.buf = this.buf.subarray(this.need)
      this.need = null
    }
    return frames
  }
}
