import fs from 'fs'
import path from 'path'

export async function jsonlUnder(dir: string, namePrefix: string): Promise<string[]> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const found = await Promise.all(
    entries.map(async (e) => {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) return jsonlUnder(p, namePrefix)
      return e.isFile() && e.name.startsWith(namePrefix) && e.name.endsWith('.jsonl') ? [p] : []
    })
  )
  return found.flat()
}
