export type CommandOutputKind = 'printed' | 'notice' | 'details'

export interface CommandOutput {
  kind: CommandOutputKind
  text: string
}
