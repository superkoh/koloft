import fs from 'fs'
import { envMs } from './sessionRuntime'

const APPEND_READ_CHUNK_BYTES = envMs('KOLOFT_APPEND_READ_CHUNK_BYTES', 256 * 1024)

export interface AppendCursor {
  offset: number
  tail: Buffer[]
}

export async function readAppendedLines(
  file: string,
  size: number,
  cur: AppendCursor
): Promise<string[] | null> {
  let newBytes: Buffer
  let fh: fs.promises.FileHandle | undefined
  try {
    fh = await fs.promises.open(file, 'r')
    const len = Math.min(size - cur.offset, APPEND_READ_CHUNK_BYTES)
    newBytes = Buffer.allocUnsafe(len)
    const { bytesRead } = await fh.read(newBytes, 0, len, cur.offset)
    if (bytesRead < len) newBytes = newBytes.subarray(0, bytesRead)
  } catch {
    return null
  } finally {
    await fh?.close()
  }
  cur.offset += newBytes.length
  const lastNl = newBytes.lastIndexOf(0x0a)
  if (lastNl === -1) {
    cur.tail.push(newBytes)
    return []
  }
  const done = newBytes.subarray(0, lastNl)
  const buf = cur.tail.length ? Buffer.concat([...cur.tail, done]) : done
  cur.tail = lastNl + 1 < newBytes.length ? [Buffer.from(newBytes.subarray(lastNl + 1))] : []
  return buf.toString('utf8').split('\n')
}
