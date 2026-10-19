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
  for (const { group, counts } of parts) {
    group.style.display = ''
    for (const c of counts) c.style.display = ''
  }
  const keeps = parts.map(({ name }) => Math.min(NAME_KEEPS_PX, name.scrollWidth))
  parts.forEach(({ name }, i) => (name.style.minWidth = `${keeps[i]}px`))
  const hidden = parts.map(countsToHide)
  parts.forEach(({ group, name, counts }, i) => {
    for (const c of counts.slice(counts.length - hidden[i])) c.style.display = 'none'
    if (hidden[i] === counts.length) group.style.display = 'none'
    name.style.minWidth = ''
  })
}

function countsToHide({ head, group, counts }: HeadParts): number {
  const limit = head.getBoundingClientRect().right - parseFloat(getComputedStyle(head).paddingRight)
  let spill = Math.max(...[...head.children].map((c) => c.getBoundingClientRect().right)) - limit
  const rights = counts.map((c) => c.getBoundingClientRect().right)
  const groupStart = group.previousElementSibling!.getBoundingClientRect().right
  let n = 0
  while (n < counts.length && spill > SUBPIXEL_SLACK_PX) {
    const i = counts.length - 1 - n
    spill -= rights[i] - (i > 0 ? rights[i - 1] : groupStart)
    n++
  }
  return n
}
