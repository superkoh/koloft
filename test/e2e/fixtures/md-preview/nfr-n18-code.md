# N18 preview code block palette

```ts
export interface N18 {
  readonly label: string
  readonly count: number
}

export function n18(label: string): N18 {
  return { label, count: 18 }
}
```

nfr-n18-body-visible
