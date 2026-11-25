import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { koloftAssist } from '../../src/main/assist'
import { readAgyModels } from '../../src/agents/agy/main/agyAccounts'
import { ASSIST_JOBS } from '../../src/core/assistJobs'
import type { ModelAndEffort } from '../../src/core/assistModels'
import { AGENT_IDS, type AgentId } from '../../src/core/agent/registry'
import type { AssistRowId } from '../../src/shared/types'
import { DEFAULT_SETTINGS } from '../../src/shared/settingsOps'
import { EVERY_AGENTS_ONE_SHOT } from './helpers/agentOneShots'

const PINNED = './assist-one-shot-text'
const ONE_SHOT_FOLDER_ARG = '--gemini_dir=/fixture/one-shot'
const SYSTEM = 'You write short titles.\nOne line only.'
const PROMPT = 'Task:\nfix the login crash\n\nand the logout one'
const ENV_KEYS = ['PIN_ACCOUNT', 'PIN_KEPT']

const envOf = (id: AgentId): NodeJS.ProcessEnv => ({
  PIN_ACCOUNT: `${id}-work`,
  PIN_KEPT: 'handed over as it is'
})

const extraArgsOf = (id: AgentId): string[] => (id === 'agy' ? [ONE_SHOT_FOLDER_ARG] : [])

const SAMPLE_REPLY: Record<AgentId, string> = {
  claude: 'Fix Login Crash\n',
  codex: 'Fix Login Crash\n',
  agy: '{"status":"SUCCESS","response":"Fix Login Crash"}\n'
}

interface Refusal {
  whenArgvHas: string
  says: string
}

interface Fake {
  bin: string
  runs(): Record<string, unknown>[]
}

const splitOnNul = (text: string): string[] => text.split('\0').slice(0, -1)

function fakeProgram(name: AgentId, reply: string, refusal?: Refusal): Fake {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-one-shot-text-'))
  const bin = path.join(dir, name)
  const runsDir = path.join(dir, 'runs')
  fs.mkdirSync(runsDir)
  fs.writeFileSync(path.join(dir, 'reply'), reply)
  if (refusal) {
    fs.writeFileSync(path.join(dir, 'refuse-when'), refusal.whenArgvHas)
    fs.writeFileSync(path.join(dir, 'refusal'), refusal.says + '\n')
  }
  fs.writeFileSync(
    bin,
    [
      '#!/bin/sh',
      `dir='${dir}'`,
      `n=$(( $(cat "$dir/count" 2>/dev/null || echo 0) + 1 ))`,
      `echo "$n" > "$dir/count"`,
      `run="$dir/runs/$n"`,
      `mkdir "$run"`,
      `printf '%s\\0' "$@" > "$run/argv"`,
      `cat > "$run/stdin"`,
      `pwd -P > "$run/cwd"`,
      `printf '%s\\0' ${ENV_KEYS.map((k) => `"$${k}"`).join(' ')} > "$run/env"`,
      `if [ -f "$dir/refuse-when" ]; then`,
      `  when=$(cat "$dir/refuse-when")`,
      `  for arg in "$@"; do`,
      `    if [ "$arg" = "$when" ]; then cat "$dir/refusal" >&2; exit 1; fi`,
      `  done`,
      `fi`,
      `cat "$dir/reply"`,
      ''
    ].join('\n'),
    { mode: 0o755 }
  )
  const read = (run: string, part: string): string =>
    fs.readFileSync(path.join(runsDir, run, part), 'utf8')
  return {
    bin,
    runs: () =>
      fs
        .readdirSync(runsDir)
        .sort((a, b) => Number(a) - Number(b))
        .map((run) => ({
          argv: splitOnNul(read(run, 'argv')),
          stdin: read(run, 'stdin'),
          cwd: read(run, 'cwd').trim(),
          env: Object.fromEntries(
            splitOnNul(read(run, 'env')).map((value, i) => [ENV_KEYS[i], value])
          )
        }))
  }
}

const TMP = os.tmpdir()
const TMP_REAL = fs.realpathSync(TMP)
const HOME = os.homedir()

const sameOnEveryMac = (text: string): string =>
  text.replaceAll(TMP_REAL, '<tmp>').replaceAll(TMP, '<tmp>').replaceAll(HOME, '<home>')

function shown(runs: Record<string, unknown>[], answer: unknown): string {
  const lines = [`runs: ${runs.length}`]
  runs.forEach((run, i) => {
    lines.push(`--- run ${i + 1}`, 'argv:')
    for (const arg of run.argv as string[]) lines.push(`  ${JSON.stringify(arg)}`)
    lines.push(`stdin: ${JSON.stringify(run.stdin)}`)
    lines.push(`cwd: ${run.cwd as string}`)
    lines.push(`env: ${JSON.stringify(run.env)}`)
  })
  lines.push(`answer: ${JSON.stringify(answer)}`)
  return sameOnEveryMac(lines.join('\n') + '\n')
}

const pin = (text: string, name: string): Promise<void> =>
  expect(text).toMatchFileSnapshot(`${PINNED}/${name}.txt`)

async function assistOn(
  id: AgentId,
  row: AssistRowId,
  fake: Fake,
  onThisAccount: (asked: ModelAndEffort) => ModelAndEffort = (asked) => asked
): Promise<string> {
  const answer = await koloftAssist({
    picks: () => ({
      assist: { backend: id },
      sessionMethods: DEFAULT_SETTINGS.sessionMethods,
      accounts: []
    }),
    enabled: () => true,
    oneShot: (backend) => EVERY_AGENTS_ONE_SHOT[backend],
    target: async (backend) =>
      backend === id
        ? {
            binary: fake.bin,
            env: envOf(id),
            ...(extraArgsOf(id).length && { args: extraArgsOf(id) }),
            done: () => {}
          }
        : null,
    onThisAccount: async (_backend, asked) => onThisAccount(asked)
  })({ row, system: SYSTEM, prompt: PROMPT })
  return shown(fake.runs(), answer)
}

const REFUSALS: Record<AgentId, { row: AssistRowId; refusal: Refusal }> = {
  claude: {
    row: 'route',
    refusal: {
      whenArgvHas: 'sonnet',
      says: "There's an issue with the selected model (sonnet). It may not exist or you may not have access to it."
    }
  },
  codex: {
    row: 'turn',
    refusal: {
      whenArgvHas: 'gpt-6.1-sol',
      says: "ERROR: The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account."
    }
  },
  agy: {
    row: 'title',
    refusal: { whenArgvHas: 'gemini-3.8-flash', says: 'Error: invalid model selection' }
  }
}

const LAUNCHES: Record<string, ModelAndEffort> = {
  'no-model-no-effort': {},
  'model-only': { model: 'the-accounts-model' },
  'effort-only': { effort: 'high' }
}

describe('the command line, input, folder and environment each agent runs an Assist job with, and the answer taken from its output', () => {
  for (const id of AGENT_IDS) {
    for (const job of ASSIST_JOBS)
      it(`${id}, the ${job.id} job`, async () => {
        await pin(
          await assistOn(id, job.id, fakeProgram(id, SAMPLE_REPLY[id])),
          `${id}/job-${job.id}`
        )
      })

    for (const [name, launch] of Object.entries(LAUNCHES))
      it(`${id}, the account's model and thinking: ${name}`, async () => {
        const text = await assistOn(id, 'title', fakeProgram(id, SAMPLE_REPLY[id]), () => launch)
        await pin(text, `${id}/launch-${name}`)
      })

    it(`${id}, the model from Koloft's table refused, then the run on the model every account takes`, async () => {
      const { row, refusal } = REFUSALS[id]
      await pin(
        await assistOn(id, row, fakeProgram(id, SAMPLE_REPLY[id], refusal)),
        `${id}/model-refused`
      )
    })
  }

  it('agy, an answer that did not succeed gives no answer', async () => {
    const fake = fakeProgram('agy', '{"status":"ERROR","response":"Fix Login Crash"}\n')
    await pin(await assistOn('agy', 'title', fake), 'agy/answer-not-a-success')
  })

  it('agy, the model list of an account', async () => {
    const fake = fakeProgram(
      'agy',
      'gemini-4-argon-low\tGemini 4 Argon\ngemini-4-argon-medium\tGemini 4 Argon\ngemini-3.8-flash-low\tGemini 3.8 Flash\n'
    )
    const listed = await readAgyModels(fake.bin, envOf('agy'), [ONE_SHOT_FOLDER_ARG])
    await pin(shown(fake.runs(), listed), 'agy/model-list')
  })
})
