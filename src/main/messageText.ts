// CC§2
export function messageText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const texts = content.flatMap((b) =>
    b?.type === 'text' && typeof b.text === 'string' ? [b.text] : []
  )
  return texts.length ? texts.join('\n') : null
}
