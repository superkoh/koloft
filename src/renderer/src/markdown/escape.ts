const HTML_ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}

/** Every plugin here builds HTML as a string, and every one of them puts document content
 *  into it — including into attributes (`data-code`, `data-path`), which is why the quotes
 *  are escaped too and not just the angle brackets. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESC[c])
}
