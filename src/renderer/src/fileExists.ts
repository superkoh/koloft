export function fileExists(p: string): Promise<boolean> {
  return window.api.fs.fileExists(p).catch(() => false)
}
