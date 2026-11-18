import type { UiParts } from '@core/ui'
import { INBOX_PAGE, INBOX_ROW } from '../plugin'
import { InboxPage, InboxRow } from './Inbox'

export const ui: UiParts = { [INBOX_ROW]: InboxRow, [INBOX_PAGE]: InboxPage }
