import { toDiscordMarkdown } from './markdown'
import { splitForDiscord } from './split'

export const NO_MENTIONS = { parse: [] }
export const IS_COMPONENTS_V2 = 1 << 15
export const SUPPRESS_NOTIFICATIONS = 1 << 12
export const TEXT_DISPLAY_LIMIT = 4000
const ACTION_ROW = 1
const BUTTON = 2
const TEXT_DISPLAY = 10
const CONTAINER = 17
const BUTTONS_PER_ROW = 5
const ROWS_OF_BUTTONS = 5
const BUTTON_LABEL_LIMIT = 80
const HEADROOM_FOR_THE_HEADER = 300

export const BUTTON_STYLE = { primary: 1, secondary: 2, success: 3, danger: 4 } as const

export interface CardButton {
  label: string
  id: string
  style: keyof typeof BUTTON_STYLE
}

export interface Card {
  accent: number
  header: string
  body?: string
  footer?: string
  buttons?: CardButton[]
  silent?: boolean
}

export const CONDUCTOR_ACCENT = 0x99aab5
const ACCENTS = [0x5865f2, 0x57f287, 0xfee75c, 0xeb459e, 0xed4245, 0x3ba55c, 0xf47b67, 0x00a8fc]

export function accentOf(name: string): number {
  let hash = 0
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0
  return ACCENTS[hash % ACCENTS.length]
}

function text(content: string): { type: number; content: string } {
  return { type: TEXT_DISPLAY, content }
}

function rows(buttons: CardButton[]): unknown[] {
  const out: unknown[] = []
  const shown = buttons.slice(0, BUTTONS_PER_ROW * ROWS_OF_BUTTONS)
  for (let i = 0; i < shown.length; i += BUTTONS_PER_ROW)
    out.push({
      type: ACTION_ROW,
      components: shown.slice(i, i + BUTTONS_PER_ROW).map((b) => ({
        type: BUTTON,
        style: BUTTON_STYLE[b.style],
        label: b.label.slice(0, BUTTON_LABEL_LIMIT),
        custom_id: b.id
      }))
    })
  return out
}

export interface CardMessage {
  flags: number
  allowed_mentions: typeof NO_MENTIONS
  components: unknown[]
}

// PLATFORM§39
export function cardMessages(card: Card): CardMessage[] {
  const body = card.body?.trim() ? toDiscordMarkdown(card.body.trim()) : ''
  const parts = body ? splitForDiscord(body, TEXT_DISPLAY_LIMIT - HEADROOM_FOR_THE_HEADER) : []
  const pieces = parts.length ? parts : ['']
  const flags = IS_COMPONENTS_V2 | (card.silent ? SUPPRESS_NOTIFICATIONS : 0)
  return pieces.map((part, i) => {
    const first = i === 0
    const last = i === pieces.length - 1
    const inside = [
      ...(first ? [text(card.header)] : []),
      ...(part ? [text(part)] : []),
      ...(last && card.footer ? [text(card.footer)] : []),
      ...(last && card.buttons?.length ? rows(card.buttons) : [])
    ]
    return {
      flags,
      allowed_mentions: NO_MENTIONS,
      components: [{ type: CONTAINER, accent_color: card.accent, components: inside }]
    }
  })
}
