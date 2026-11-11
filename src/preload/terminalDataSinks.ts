type Sink = (data: string) => void

export class TerminalDataSinks {
  private readonly sinks = new Map<string, Sink>()
  private readonly heldForAFirstScreen = new Map<string, string[]>()
  private readonly everListened = new Set<string>()

  deliver(id: string, data: string): void {
    const sink = this.sinks.get(id)
    if (sink) return sink(data)
    if (this.everListened.has(id)) return
    const held = this.heldForAFirstScreen.get(id)
    if (held) held.push(data)
    else this.heldForAFirstScreen.set(id, [data])
  }

  listen(id: string, sink: Sink): () => void {
    this.sinks.set(id, sink)
    this.everListened.add(id)
    const held = this.heldForAFirstScreen.get(id)
    this.heldForAFirstScreen.delete(id)
    for (const data of held ?? []) sink(data)
    return () => {
      this.sinks.delete(id)
    }
  }
}
