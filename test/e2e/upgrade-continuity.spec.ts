import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { seedSettings, type E2EEnv } from './helpers/env'
import {
  assistRecordOnDisk,
  readCalls,
  resumedId,
  runIn,
  centerTerm,
  seedJsonl,
  settingsOnDisk,
  startSessionIn,
  waitBooted
} from './helpers/p1'
import { startFakeDiscord, type FakeDiscord } from './helpers/fakeDiscord'
import { installFakeRemote, killFakeRemote, remoteKey, seedRemoteWorkspace } from './helpers/remote'

test.setTimeout(180_000)

const OWNER = { id: '555', username: 'letian' }
const CHANNEL = { guildId: '111', channelId: '222', name: 'koloft-all' }
const ASSIST_STARTS_AND_ANSWERS_MS = 60_000
const FOLDER_HASH_CHARS = 16

// ADR-0029
function assistFolder(env: E2EEnv, scope: string): string {
  if (scope === 'global') return path.join(env.userData, 'conductors', 'global')
  const hash = crypto.createHash('sha256').update(scope).digest('hex').slice(0, FOLDER_HASH_CHARS)
  return path.join(env.userData, 'conductors', hash)
}

function seedV038(
  env: E2EEnv,
  binding: { scope: string; backend: 'claude' | 'codex'; lastSessionKey?: string },
  extra: Record<string, unknown> = {}
): void {
  const keys = binding.lastSessionKey ? [binding.lastSessionKey] : []
  seedSettings(env, {
    hintsOff: true,
    ...extra,
    discord: {
      userId: OWNER.id,
      userName: OWNER.username,
      bindings: [
        {
          id: 'b1',
          scope: binding.scope,
          backend: binding.backend,
          channel: CHANNEL,
          sessionIds: keys,
          ...(binding.lastSessionKey ? { lastSessionKey: binding.lastSessionKey } : {}),
          touched: []
        }
      ]
    }
  })
}

function said(fake: FakeDiscord): string[] {
  return fake.posted.filter((p) => p.channelId === CHANNEL.channelId).map((p) => p.content)
}

async function answersOnDiscord(fake: FakeDiscord, words: string): Promise<void> {
  fake.say(OWNER, words)
  await expect
    .poll(() => said(fake).some((text) => text.includes(words)), {
      timeout: ASSIST_STARTS_AND_ANSWERS_MS
    })
    .toBe(true)
}

function peerLinesReceived(env: E2EEnv): string {
  const file = path.join(env.home, 'fake-claude-peer.jsonl')
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}

function assistCalls(env: E2EEnv, scope: string) {
  return readCalls(env).filter((c) => c.cwd === assistFolder(env, scope))
}

async function upgradedApp(env: E2EEnv, fake: FakeDiscord) {
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await waitBooted(page)
  await expect.poll(() => fake.identifies).toBeGreaterThan(0)
  return { app, page }
}

function writtenBindingsAnOlderKoloftKeeps(env: E2EEnv): void {
  const bindings = (settingsOnDisk(env).discord as { bindings: Record<string, unknown>[] }).bindings
  expect(bindings.length).toBeGreaterThan(0)
  for (const b of bindings) {
    expect(['claude', 'codex']).toContain(b.backend)
    expect(b).toMatchObject({ id: expect.any(String), scope: expect.any(String) })
    expect(b).not.toHaveProperty('sessionIds')
  }
}

test.describe('Upgrade continuity: what v0.38.0 left on disk keeps working after the upgrade', () => {
  test('the global Assist on Claude, Assist never chosen, becomes the butler: it resumes the same conversation, answers in Discord, and does again after a restart; the settings it writes still keep its binding for an older Koloft', async ({
    env
  }) => {
    const last = crypto.randomUUID()
    seedV038(env, { scope: 'global', backend: 'claude', lastSessionKey: last })
    seedJsonl(env, assistFolder(env, 'global'), { id: last })
    const fake = await startFakeDiscord(env)
    try {
      const first = await upgradedApp(env, fake)
      await expect
        .poll(() => assistCalls(env, 'global').map(resumedId), {
          timeout: ASSIST_STARTS_AND_ANSWERS_MS
        })
        .toEqual([last])
      await answersOnDiscord(fake, 'hello after the upgrade')
      expect(assistRecordOnDisk(env, 'global')?.lastSessionKey).toBe(last)
      writtenBindingsAnOlderKoloftKeeps(env)
      await quitAndClose(first.app)

      const again = await upgradedApp(env, fake)
      await expect
        .poll(() => assistCalls(env, 'global').map(resumedId), {
          timeout: ASSIST_STARTS_AND_ANSWERS_MS
        })
        .toEqual([last, last])
      await answersOnDiscord(fake, 'hello after a restart')
      await quitAndClose(again.app)
    } finally {
      await fake.close()
    }
  })

  for (const where of ['workspace', 'remote workspace'] as const) {
    test(`an owner who bound only a ${where}’s channel finds the butler answering in that channel: a new conversation in the butler’s own folder, the workspace Assist’s own left behind`, async ({
      env
    }) => {
      if (where === 'remote workspace') {
        installFakeRemote(env)
        seedRemoteWorkspace(env)
      }
      const scope = where === 'workspace' ? env.workspaces.a : remoteKey(env)
      const last = crypto.randomUUID()
      seedV038(env, { scope, backend: 'claude', lastSessionKey: last })
      seedJsonl(env, assistFolder(env, scope), { id: last })
      const fake = await startFakeDiscord(env)
      try {
        const first = await upgradedApp(env, fake)
        await expect
          .poll(() => assistCalls(env, 'global').map(resumedId), {
            timeout: ASSIST_STARTS_AND_ANSWERS_MS
          })
          .toEqual([undefined])
        await answersOnDiscord(fake, 'hello after the upgrade')
        expect(assistCalls(env, scope)).toEqual([])
        writtenBindingsAnOlderKoloftKeeps(env)
        const [kept] = (settingsOnDisk(env).discord as { bindings: Record<string, unknown>[] })
          .bindings
        expect(kept).toMatchObject({ scope: 'global', channel: CHANNEL })
        expect(assistRecordOnDisk(env, scope)).toBeUndefined()
        await quitAndClose(first.app)
      } finally {
        await fake.close()
        if (where === 'remote workspace') killFakeRemote(env)
      }
    })
  }

  test('an Assist that ran on Codex while new sessions default to Claude starts a new conversation on Claude and still answers in Discord', async ({
    env
  }) => {
    seedV038(env, { scope: 'global', backend: 'codex', lastSessionKey: 'codex:019a0000-old' })
    const fake = await startFakeDiscord(env)
    try {
      const { app } = await upgradedApp(env, fake)
      await expect
        .poll(() => assistCalls(env, 'global').length, { timeout: ASSIST_STARTS_AND_ANSWERS_MS })
        .toBe(1)
      expect(resumedId(assistCalls(env, 'global')[0])).toBeUndefined()
      await answersOnDiscord(fake, 'hello from a Codex Assist')
      await expect
        .poll(() => assistRecordOnDisk(env, 'global')?.lastSessionKey)
        .not.toBe('codex:019a0000-old')
      expect(
        (settingsOnDisk(env).discord as { bindings: { backend: string }[] }).bindings[0].backend
      ).toBe('claude')
      await quitAndClose(app)
    } finally {
      await fake.close()
    }
  })

  test('when new sessions default to Codex but Codex is not on this Mac, the Assist runs on Claude and answers in Discord', async ({
    env
  }) => {
    seedV038(
      env,
      { scope: 'global', backend: 'codex' },
      { sessionMethods: { defaultBackend: 'codex', enabled: { claude: true, codex: true } } }
    )
    const fake = await startFakeDiscord(env)
    try {
      const { app } = await upgradedApp(env, fake)
      await expect
        .poll(() => assistCalls(env, 'global').length, { timeout: ASSIST_STARTS_AND_ANSWERS_MS })
        .toBe(1)
      await answersOnDiscord(fake, 'hello with Codex missing')
      await quitAndClose(app)
    } finally {
      await fake.close()
    }
  })

  test('a session started before the upgrade still reaches the butler by its old names, Global-conductor and Global-Assist', async ({
    env
  }) => {
    seedV038(env, { scope: 'global', backend: 'claude' })
    const fake = await startFakeDiscord(env)
    try {
      const { app, page } = await upgradedApp(env, fake)
      await expect
        .poll(() => assistRecordOnDisk(env, 'global')?.sessionIds.length ?? 0, {
          timeout: ASSIST_STARTS_AND_ANSWERS_MS
        })
        .toBeGreaterThan(0)
      await startSessionIn(page, 'ws-a')
      await runIn(page, centerTerm(page), '/koloft session send Global-conductor "report: done"')
      await expect
        .poll(() => peerLinesReceived(env), { timeout: ASSIST_STARTS_AND_ANSWERS_MS })
        .toContain('report: done')
      await runIn(page, centerTerm(page), '/koloft session send Global-Assist "report: again"')
      await expect
        .poll(() => peerLinesReceived(env), { timeout: ASSIST_STARTS_AND_ANSWERS_MS })
        .toContain('report: again')
      await quitAndClose(app)
    } finally {
      await fake.close()
    }
  })
})
