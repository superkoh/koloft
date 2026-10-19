export const NAME_KEEPS_PX = 44
const SUBPIXEL_SLACK_PX = 0.5

interface HeadParts {
  head: HTMLElement
  group: HTMLElement
  name: HTMLElement
  counts: HTMLElement[]
}

export function fitGithubCounts(heads: Iterable<HTMLElement>): void {
  const parts: HeadParts[] = []
  for (const head of heads) {
    const group = head.querySelector<HTMLElement>('.ws-gh')
    const name = head.querySelector<HTMLElement>('.ws-name')
    if (group && name)
      parts.push({ head, group, name, counts: [...group.children] as HTMLElement[] })
  }
  for (const { group, name, counts } of parts) {
    group.style.display = ''
    for (const c of counts) c.style.display = ''
    name.style.flexShrink = '0'
    name.style.maxWidth = `${NAME_KEEPS_PX}px`
  }
  const hidden = parts.map(countsToHide)
  parts.forEach(({ group, name, counts }, i) => {
    for (const c of counts.slice(counts.length - hidden[i])) c.style.display = 'none'
    if (hidden[i] === counts.length) group.style.display = 'none'
    name.style.flexShrink = ''
    name.style.maxWidth = ''
  })
}

function countsToHide({ head, counts }: HeadParts): number {
  const limit = head.getBoundingClientRect().right - parseFloat(getComputedStyle(head).paddingRight)
  let spill = Math.max(...[...head.children].map((c) => c.getBoundingClientRect().right)) - limit
  if (spill <= SUBPIXEL_SLACK_PX) return 0
  const rights = counts.map((c) => c.getBoundingClientRect().right)
  let shown = counts.length
  while (shown > 0 && spill > SUBPIXEL_SLACK_PX) {
    shown--
    if (shown > 0) spill -= rights[shown] - rights[shown - 1]
  }
  return counts.length - shown
}
