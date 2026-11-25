export interface CodexWire {
  onFrame(direction: 'client' | 'server', frame: unknown): void
  observes(direction: 'client' | 'server', head: { method?: string; replyTo?: unknown }): boolean
}

export const codexWires: CodexWire[] = []
