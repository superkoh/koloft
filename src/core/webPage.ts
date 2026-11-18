// ADR-0051
export interface WebPage {
  guestId: number
  url(): string
  run(script: string): Promise<unknown>
}
