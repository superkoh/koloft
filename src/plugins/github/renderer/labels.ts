export function countLabel(n: number): string {
  return n < 1000 ? `${n}` : `${Math.floor(n / 100) / 10}k`
}

export function openIssuesLabel(n: number): string {
  return `${n} open issue${n === 1 ? '' : 's'}`
}

export function openPullsLabel(n: number): string {
  return `${n} open pull request${n === 1 ? '' : 's'}`
}
