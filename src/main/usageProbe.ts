import { GRACE } from '@shared/accountUsage'

export const DW = 21_600
export { GRACE }
export const EPS = 0.05

export function disc(r: number, d: number, now: number): number {
  if (r <= 0) return 1.0
  const t = r - now
  if (t <= 0) return 0.0
  if (t >= d) return 1.0
  return t / d
}

export interface Score {
  s1: number
  s2: number
  tiebreak: number
  pen: number
  hardLimited: boolean
}

export function weekUse(used: number, resetsAt: number, now: number): number {
  return used * disc(resetsAt, DW, now)
}

export interface Candidate {
  name: string
  score: Score
}

export const RESET_TIE_S = DW

type Ranked = { score: Pick<Score, 's1' | 's2' | 'tiebreak'> }

const tbOf = (c: Ranked): number => (c.score.tiebreak > 0 ? c.score.tiebreak : Infinity)

export function leximaxFinalists<C extends Ranked>(cands: C[]): C[] {
  let survivors = cands
  for (const key of ['s1', 's2'] as const) {
    if (survivors.length <= 1) break
    const min = Math.min(...survivors.map((c) => c.score[key]))
    survivors = survivors.filter((c) => c.score[key] <= min + EPS)
  }
  if (survivors.length <= 1) return survivors
  const earliest = Math.min(...survivors.map(tbOf))
  return survivors.filter((c) => tbOf(c) <= earliest + RESET_TIE_S)
}
