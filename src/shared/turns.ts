export type Speaker = 'owner' | 'peer' | 'assistant'

export interface SaidLine {
  who: Speaker
  text: string
  at: number
}

export interface Turn {
  said: SaidLine[]
  reply: string
  at: number
}

export interface TurnEnded extends Turn {
  tabId: string
  sessionKey: string
}

export const MAX_READ_TURNS = 20

export class TurnLog {
  private turns: Turn[] = []
  private ended = new WeakSet<Turn>()

  add(line: SaidLine, joinsOpenTurn = false): void {
    const open = this.open()
    if (line.who === 'assistant') {
      const turn = open ?? this.start()
      turn.reply = turn.reply ? `${turn.reply}\n\n${line.text}` : line.text
      turn.at = line.at
      return
    }
    const turn = open && (joinsOpenTurn || !open.reply) ? open : this.start()
    turn.said.push(line)
    turn.at = line.at
  }

  open(): Turn | undefined {
    const last = this.turns[this.turns.length - 1]
    return last && !this.ended.has(last) ? last : undefined
  }

  end(turn: Turn): boolean {
    if (this.ended.has(turn)) return false
    this.ended.add(turn)
    return true
  }

  last(n: number): Turn[] {
    return this.turns.slice(-n)
  }

  private start(): Turn {
    const turn: Turn = { said: [], reply: '', at: 0 }
    this.turns.push(turn)
    if (this.turns.length > MAX_READ_TURNS) this.turns.shift()
    return turn
  }
}
