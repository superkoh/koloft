export function endsMidPair(text: string, cut: number): boolean {
  const code = text.charCodeAt(cut - 1)
  return code >= 0xd800 && code <= 0xdbff
}
