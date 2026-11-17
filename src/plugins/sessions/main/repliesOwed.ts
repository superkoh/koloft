export interface OwedToSession {
  owner: string
  asked?: string
}

export type ReplyListener = (reply: string) => void

interface EndedTurn {
  reply: string
  said: readonly { text: string }[]
}

export class RepliesOwed {
  private toSessions = new Map<string, OwedToSession>()
  private toListeners = new Map<string, ReplyListener>()

  owesSession(tab: string, sessionId: string): boolean {
    return this.toSessions.get(tab)?.owner === sessionId
  }

  oweSession(tab: string, owed: OwedToSession): void {
    this.toSessions.set(tab, owed)
  }

  forgetSession(tab: string): void {
    this.toSessions.delete(tab)
  }

  oweListener(tab: string, listener: ReplyListener): void {
    this.toListeners.set(tab, listener)
  }

  async owing<T>(
    tab: string,
    owed: OwedToSession | undefined,
    act: () => Promise<T>,
    failed: (result: T) => boolean = () => false
  ): Promise<T> {
    const before = this.toSessions.get(tab)
    if (owed) this.toSessions.set(tab, owed)
    const takeBack = (): void => {
      if (!owed || this.toSessions.get(tab) !== owed) return
      if (before) this.toSessions.set(tab, before)
      else this.toSessions.delete(tab)
    }
    try {
      const result = await act()
      if (failed(result)) takeBack()
      return result
    } catch (error) {
      takeBack()
      throw error
    }
  }

  turnEnded(tab: string, turn: EndedTurn, payOwner: (owner: string) => boolean): boolean {
    const reply = turn.reply.trim()
    const listener = this.toListeners.get(tab)
    if (listener && reply) {
      this.toListeners.delete(tab)
      listener(reply)
      return true
    }
    const owed = this.toSessions.get(tab)
    if (!owed) return false
    const { owner, asked } = owed
    if (asked !== undefined && !turn.said.some((l) => l.text.includes(asked))) return false
    this.toSessions.delete(tab)
    return !!reply && payOwner(owner)
  }

  moved(oldTab: string, newTab: string): void {
    carryOver(this.toSessions, oldTab, newTab)
    carryOver(this.toListeners, oldTab, newTab)
  }
}

function carryOver<V>(debts: Map<string, V>, oldTab: string, newTab: string): void {
  const debt = debts.get(oldTab)
  if (debt === undefined) return
  debts.delete(oldTab)
  debts.set(newTab, debt)
}
