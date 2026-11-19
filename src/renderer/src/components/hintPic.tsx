import type { JSX } from 'react'

export function Pic(p: { h: number; label: string; children: JSX.Element }): JSX.Element {
  return (
    <svg className="pic" viewBox={`0 0 244 ${p.h}`} role="img" aria-label={p.label}>
      <rect
        x="0.5"
        y="0.5"
        width="243"
        height={p.h - 1}
        rx="6"
        fill="var(--bg-0)"
        stroke="var(--line)"
      />
      {p.children}
    </svg>
  )
}

export interface HintWords {
  title: string
  body: JSX.Element
  pic: JSX.Element
}
