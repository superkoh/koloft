export const NAME_KEEPS_PX = 44
const SUBPIXEL_SLACK_PX = 0.5

export function fitGithubCounts(head: HTMLElement): void {
  const group = head.querySelector<HTMLElement>('.ws-gh')
  const name = head.querySelector<HTMLElement>('.ws-name')
  if (!group || !name) return
  const counts = [...group.children] as HTMLElement[]
  group.style.display = ''
  for (const c of counts) c.style.display = ''
  name.style.minWidth = `${Math.min(NAME_KEEPS_PX, name.scrollWidth)}px`
  const limit = head.getBoundingClientRect().right - parseFloat(getComputedStyle(head).paddingRight)
  const overflows = (): boolean =>
    Math.max(...[...head.children].map((c) => c.getBoundingClientRect().right)) >
    limit + SUBPIXEL_SLACK_PX
  while (counts.length && overflows()) counts.pop()!.style.display = 'none'
  if (!counts.length) group.style.display = 'none'
  name.style.minWidth = ''
}
