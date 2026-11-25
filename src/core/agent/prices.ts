import { firstPriceOf } from '@shared/pricing'
import { AGENT_MANIFESTS } from './registry'

export const resolvePricing = firstPriceOf(
  AGENT_MANIFESTS.map((agent) => agent.pureFunctions.priceOf)
)
