import { PLUGINS } from '@plugins/list'

export const PLUGIN_OPENINGS: readonly string[] = PLUGINS.flatMap((p) => p.openings ?? [])
