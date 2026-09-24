import fs from 'fs'

export function writePrivateAtomically(file: string, text: string): void {
  const tmp = `${file}.koloft-${process.pid}`
  fs.writeFileSync(tmp, text, { mode: 0o600 })
  fs.renameSync(tmp, file)
}
