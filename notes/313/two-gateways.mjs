import { execFileSync } from 'node:child_process'

const API = 'https://discord.com/api/v10'
const GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json'
const INTENTS_GUILDS_AND_GUILD_MESSAGES = 1 | 512
const IDENTIFY_SPACING_MS = 5500
const COMMAND_NAME = 'probe313'
const TEST_BOT_SERVICE = 'koloft-dev-discord-bot'
const RELEASE_BOT_SERVICE = 'koloft-discord-bot'
const USER_AGENT = 'DiscordBot (https://github.com/superkoh/koloft, 0.0)'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name, fallback) => {
  const at = args.indexOf(name)
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback
}
const waitSeconds = Number(option('--wait', '60'))
const channelArg = option('--channel', '')
const register = flag('--register')
const cleanup = flag('--cleanup')

const started = Date.now()
const stamp = () => `${new Date().toISOString()} +${((Date.now() - started) / 1000).toFixed(3)}s`
const log = (line) => console.log(`${stamp()} ${line}`)
const short = (id) => (id ? `…${String(id).slice(-4)}` : '-')

function keychain(service) {
  try {
    return execFileSync('security', ['find-generic-password', '-s', service, '-a', 'bot', '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).replace(/\n$/, '')
  } catch {
    return ''
  }
}

const token = process.env.DISCORD_BOT_TOKEN || keychain(TEST_BOT_SERVICE)
if (!token) {
  console.error(`no token: set DISCORD_BOT_TOKEN or store one under ${TEST_BOT_SERVICE}`)
  process.exit(2)
}
if (token === keychain(RELEASE_BOT_SERVICE)) {
  console.error('refusing: this token is the installed app’s bot; use a test bot')
  process.exit(2)
}

async function rest(method, path, body) {
  const response = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bot ${token}`,
      'User-Agent': USER_AGENT,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await response.text()
  return { status: response.status, json: text ? JSON.parse(text) : null }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function openConnection(number, onDispatch) {
  const state = { number, ready: false, sent: 0, acked: 0, closes: [], seq: null }
  return new Promise((resolveReady) => {
    const ws = new WebSocket(GATEWAY)
    state.ws = ws
    let beat
    ws.addEventListener('message', (event) => {
      const packet = JSON.parse(event.data)
      if (packet.s != null) state.seq = packet.s
      if (packet.op === 10) {
        beat = setInterval(() => {
          state.sent++
          ws.send(JSON.stringify({ op: 1, d: state.seq }))
        }, packet.d.heartbeat_interval)
        ws.send(
          JSON.stringify({
            op: 2,
            d: {
              token,
              intents: INTENTS_GUILDS_AND_GUILD_MESSAGES,
              properties: { os: 'darwin', browser: 'probe313', device: 'probe313' }
            }
          })
        )
        log(`conn ${number}: hello, identify sent`)
      } else if (packet.op === 11) {
        state.acked++
      } else if (packet.op === 7) {
        log(`conn ${number}: op 7 reconnect asked`)
      } else if (packet.op === 9) {
        log(`conn ${number}: op 9 invalid session, resumable=${packet.d}`)
      } else if (packet.op === 0) {
        if (packet.t === 'READY') {
          state.ready = true
          state.guilds = packet.d.guilds.map((guild) => guild.id)
          log(
            `conn ${number}: READY, shard=${JSON.stringify(packet.d.shard ?? null)}, guilds=${state.guilds.length}`
          )
          resolveReady(state)
        }
        onDispatch(state, packet)
      }
    })
    ws.addEventListener('close', (event) => {
      clearInterval(beat)
      state.closes.push(`${event.code} ${event.reason || ''}`.trim())
      log(`conn ${number}: closed ${event.code} ${event.reason || ''}`)
      resolveReady(state)
    })
  })
}

const seen = { messages: new Map(), interactions: new Map() }
let probeMessageId = null

async function onDispatch(state, packet) {
  if (packet.t === 'MESSAGE_CREATE') {
    seen.messages.set(packet.d.id, [...(seen.messages.get(packet.d.id) ?? []), state.number])
    log(`conn ${state.number}: MESSAGE_CREATE id=${packet.d.id}`)
  }
  if (packet.t !== 'INTERACTION_CREATE') return
  const interaction = packet.d
  const list = seen.interactions.get(interaction.id) ?? []
  list.push(state.number)
  seen.interactions.set(interaction.id, list)
  log(
    `conn ${state.number}: INTERACTION_CREATE id=${interaction.id} type=${interaction.type} name=${interaction.data?.name ?? '-'} user=${short(interaction.member?.user?.id ?? interaction.user?.id)}`
  )
  if (state.number !== 1) return
  const answer = await rest(
    'POST',
    `/interactions/${interaction.id}/${interaction.token}/callback`,
    {
      type: 4,
      data: {
        flags: 64,
        content: `conn 1 got interaction ${interaction.id} at ${new Date().toISOString()}`
      }
    }
  )
  log(`conn 1: callback answered ${answer.status}`)
}

const me = await rest('GET', '/users/@me')
const application = await rest('GET', '/oauth2/applications/@me')
log(
  `bot ${me.status === 200 ? 'ok' : me.status}, application ${application.status === 200 ? 'ok' : application.status}`
)
if (me.status !== 200 || application.status !== 200) process.exit(1)
const appId = application.json.id

async function findChannel(nameOrId) {
  if (/^\d+$/.test(nameOrId)) {
    const channel = await rest('GET', `/channels/${nameOrId}`)
    return channel.status === 200 ? channel.json : null
  }
  const guilds = await rest('GET', '/users/@me/guilds')
  for (const guild of guilds.json ?? []) {
    const channels = await rest('GET', `/guilds/${guild.id}/channels`)
    const match = (channels.json ?? []).find(
      (channel) => channel.type === 0 && channel.name === nameOrId
    )
    if (match) return match
  }
  return null
}

let channelId = ''
let guildId = ''
if (channelArg) {
  const channel = await findChannel(channelArg)
  if (!channel) {
    console.error(`channel ${channelArg} not found among the bot’s servers`)
    process.exit(2)
  }
  channelId = channel.id
  guildId = channel.guild_id
  log(`channel ${short(channelId)} found`)
}

const commandsPath = () => `/applications/${appId}/guilds/${guildId}/commands`
async function existingCommandId() {
  const list = await rest('GET', commandsPath())
  return (list.json ?? []).find((command) => command.name === COMMAND_NAME)?.id ?? ''
}

if (register) {
  if (!guildId) {
    console.error('--register needs --channel <name or id> in the server to register in')
    process.exit(2)
  }
  if (await existingCommandId()) {
    log(`/${COMMAND_NAME} already registered`)
  } else {
    const made = await rest('POST', commandsPath(), {
      name: COMMAND_NAME,
      description: 'Two-connection probe: which connection gets this',
      type: 1
    })
    log(`register /${COMMAND_NAME}: ${made.status}`)
  }
}

const one = await openConnection(1, onDispatch)
await sleep(IDENTIFY_SPACING_MS)
const two = await openConnection(2, onDispatch)
log(`both opened: conn 1 ready=${one.ready}, conn 2 ready=${two.ready}`)

if (channelId) {
  await sleep(1000)
  const posted = await rest('POST', `/channels/${channelId}/messages`, {
    content: `probe313: message check ${new Date().toISOString()}`,
    flags: 1 << 12
  })
  probeMessageId = posted.json?.id ?? null
  log(`probe message posted: ${posted.status} id=${probeMessageId}`)
}

log(`listening ${waitSeconds}s; use /${COMMAND_NAME} in the server now`)
await sleep(waitSeconds * 1000)

for (const state of [one, two]) {
  log(
    `conn ${state.number}: ready=${state.ready} heartbeats sent=${state.sent} acked=${state.acked} closes=${JSON.stringify(state.closes)} open=${state.ws.readyState === WebSocket.OPEN}`
  )
}
if (channelId)
  log(`probe message seen by conns: ${JSON.stringify(seen.messages.get(probeMessageId) ?? [])}`)
for (const [id, conns] of seen.interactions)
  log(`interaction ${id} seen by conns: ${JSON.stringify(conns)}`)
if (!seen.interactions.size) log('no interaction seen')

one.ws.close(1000)
two.ws.close(1000)

if (cleanup && guildId) {
  const commandId = await existingCommandId()
  if (commandId) {
    const removed = await rest('DELETE', `${commandsPath()}/${commandId}`)
    log(`delete /${COMMAND_NAME}: ${removed.status}`)
  }
}
await sleep(500)
process.exit(0)
