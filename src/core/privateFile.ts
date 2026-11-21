import fs from 'fs'

export function writePrivateAtomically(file: string, text: string): void {
  const tmp = `${file}.koloft-${process.pid}`
  fs.writeFileSync(tmp, text, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

export class PrivateRecordFile<T> {
  private record: Record<string, T> | null = null

  constructor(private readonly file: () => string) {}

  get(): Record<string, T> {
    if (!this.record) {
      try {
        const read: unknown = JSON.parse(fs.readFileSync(this.file(), 'utf8'))
        this.record =
          read && typeof read === 'object' && !Array.isArray(read)
            ? (read as Record<string, T>)
            : {}
      } catch {
        this.record = {}
      }
    }
    return this.record
  }

  save(): void {
    try {
      writePrivateAtomically(this.file(), JSON.stringify(this.record))
    } catch {}
  }

  forget(key: string): void {
    const record = this.get()
    if (!(key in record)) return
    delete record[key]
    this.save()
  }
}
