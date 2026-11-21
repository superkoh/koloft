// ADR-0051
export interface OwnerWaits {
  waitsOnTheOwner(tabId: string): void
  ownerAnswered(tabId: string): void
}
