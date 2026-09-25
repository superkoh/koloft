export interface ActionOverrides {
  title?: string
  text?: string
}

export interface ActionState extends ActionOverrides {
  id: string
  tabs: Record<string, ActionOverrides>
}

export interface ActionRowState {
  activeTabId?: number
  actions: ActionState[]
}

export interface ActionView {
  id: string
  name: string
  badge: string
}

const ROW_MAX = 4
const ROW_KEPT = 3

export function actionView(action: ActionState, activeTabId: number | undefined): ActionView {
  const scoped = activeTabId === undefined ? undefined : action.tabs[String(activeTabId)]
  const pick = (key: keyof ActionOverrides): string | undefined =>
    scoped && key in scoped ? scoped[key] : action[key]
  return {
    id: action.id,
    name: pick('title') || action.id,
    badge: pick('text') ?? ''
  }
}

export function splitActions<T>(actions: readonly T[]): {
  shown: readonly T[]
  menu: readonly T[] | null
} {
  if (actions.length <= ROW_MAX) return { shown: actions, menu: null }
  return { shown: actions.slice(0, ROW_KEPT), menu: actions }
}
