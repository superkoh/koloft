export async function fileExists(p: string): Promise<boolean> {
  try {
    await window.api.preview.readText(p)
    return true
  } catch (err) {
    const msg = String((err as Error)?.message ?? '')
    return msg.includes('KOLOFT_TOO_LARGE') || msg.includes('KOLOFT_BINARY')
  }
}
