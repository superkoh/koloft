export const TAB_IDS_KEPT_PER_TAB = 8

const keepingTheFirstStarted = (ids: string[], most: number): string[] =>
  ids.length <= most ? ids : [...ids.slice(0, most - 1), ids[ids.length - 1]]

export function tabIdList(tabId: string, earlier: string[]): string[] {
  return keepingTheFirstStarted([tabId, ...earlier], TAB_IDS_KEPT_PER_TAB)
}

export function carriedTabIds(newId: string, before: string[], ids: string[]): string[] {
  const merged = new Set([...ids, ...before])
  merged.delete(newId)
  return keepingTheFirstStarted([...merged], TAB_IDS_KEPT_PER_TAB - 1)
}
