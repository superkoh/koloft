// ADR-0051
import type { UiParts } from '@core/ui'
import { ui as inbox } from './inbox/renderer/ui'

export const PLUGIN_UIS: Readonly<Record<string, UiParts>> = { inbox }
