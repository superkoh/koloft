/**
 * The pure half of the address bar's extension action row (design §03 / D3, D4). The
 * shape of `ActionState` is the upstream browserAction state as
 * `window.browserAction.getState(partition)` reports it — Koloft renders its own row on top
 * of it rather than mounting the library's `<browser-action-list>`, which paints a shadow
 * DOM this app cannot label or style.
 */

export interface ActionOverrides {
  title?: string
  text?: string
}

export interface ActionState extends ActionOverrides {
  id: string
  /** per-tab overrides of the fields above, keyed by tab id */
  tabs: Record<string, ActionOverrides>
}

export interface ActionRowState {
  activeTabId?: number
  actions: ActionState[]
}

/** One button of the action row. */
export interface ActionView {
  id: string
  /** the aria-label and the overflow menu's row text */
  name: string
  /** badge text, '' when the extension paints none */
  badge: string
}

/** D3's boundary: up to this many extensions all stay on the row. */
const ROW_MAX = 4
/** what stays on the row once the puzzle appears */
const ROW_KEPT = 3

/**
 * chrome.action.setTitle/setBadgeText may be scoped to one tab, so the row reads the
 * override belonging to the tab the extension itself calls active (D4). An override is
 * taken by presence, not by truthiness: `setBadgeText({ text: '', tabId })` is how an
 * extension takes its badge off one tab while keeping it everywhere else.
 */
export function actionView(action: ActionState, activeTabId: number | undefined): ActionView {
  const scoped = activeTabId === undefined ? undefined : action.tabs[String(activeTabId)]
  const pick = (key: keyof ActionOverrides): string | undefined =>
    scoped && key in scoped ? scoped[key] : action[key]
  return {
    id: action.id,
    // an unlabelled button is unreachable — the id is ugly but it is a name
    name: pick('title') || action.id,
    badge: pick('text') ?? ''
  }
}

/**
 * D3: the puzzle is a pure overflow entry, not a permanent home — it appears only past
 * four extensions, and its menu then lists every one of them (the three on the row
 * included), so the menu is always the whole set rather than the remainder.
 */
export function splitActions<T>(actions: readonly T[]): {
  shown: readonly T[]
  menu: readonly T[] | null
} {
  if (actions.length <= ROW_MAX) return { shown: actions, menu: null }
  return { shown: actions.slice(0, ROW_KEPT), menu: actions }
}
