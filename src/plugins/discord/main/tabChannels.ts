export interface TabChannelDeps {
  butlerSide(tabId: string): boolean
  lobby(): string | undefined
  boundChannelOf(tabId: string): string | undefined
  roomCarrying(tabId: string): string | undefined
}

export interface TabChannels {
  roomOf(tabId: string): string | undefined
  askChannelOf(tabId: string): string | undefined
  phoneChannelOf(tabId: string): string | undefined
}

export function tabChannels(d: TabChannelDeps): TabChannels {
  const roomOf = (tabId: string): string | undefined =>
    d.butlerSide(tabId) ? undefined : d.roomCarrying(tabId)
  return {
    roomOf,
    askChannelOf: (tabId) => (d.butlerSide(tabId) ? d.lobby() : roomOf(tabId)),
    phoneChannelOf: (tabId) => d.boundChannelOf(tabId) ?? roomOf(tabId)
  }
}
