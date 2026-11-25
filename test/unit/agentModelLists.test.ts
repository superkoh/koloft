import { describe, expect, it } from 'vitest'
import { AGENT_IDS, agentManifest } from '../../src/core/agent/registry'
import { TASK_TIERS } from '../../src/core/agent/manifest'
import { agentsWithTheirCatalogs } from './helpers/agentCatalogs'

const listsItsModels = (id: (typeof AGENT_IDS)[number]): boolean =>
  agentManifest(id).flags.listsTheModelsAnAccountCanRun

describe('an agent that lists no models an account can run', () => {
  it('reads no model list', async () => {
    const agents = agentsWithTheirCatalogs({ codexConfig: '/nowhere', ownersGemini: '/nowhere' })
    for (const id of AGENT_IDS.filter((id) => !listsItsModels(id)))
      expect(await agents.listedModels(id)).toBeUndefined()
  })

  it('names the model of each task tier by one of its named models, with no stand-in family and no model some accounts lack; one that lists them names each tier by a family', () => {
    for (const id of AGENT_IDS) {
      const manifest = agentManifest(id)
      const named = manifest.namedModels.map((m) => m.id)
      const tierModels = TASK_TIERS.map((tier) => manifest.picksByTaskTier[tier].model)
      if (listsItsModels(id)) {
        expect(
          tierModels.filter((model) => named.includes(model)),
          id
        ).toEqual([])
      } else {
        expect(
          tierModels.filter((model) => !named.includes(model)),
          id
        ).toEqual([])
        expect(manifest.normalTaskFamilyEveryAccountHas, id).toBeUndefined()
        expect(
          manifest.namedModels.filter((m) => m.notOnEveryAccount),
          id
        ).toEqual([])
      }
    }
  })
})
