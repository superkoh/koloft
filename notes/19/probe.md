# #19 probe: what `navigator.permissions.query` can answer in Electron

Electron 43.7.3 (Chrome 150.0.7871.250), macOS, run 2026-10-13. A plain Electron main script, one hidden `BrowserWindow` per launch (each variant in its own launch), a `file://` page (a secure context), `--use-fake-device-for-media-stream`. The request handler always refuses. Launched through Playwright's `_electron.launch`, the way the e2e suite launches the app.

## Results

| Variant | `query()` mic / camera / geolocation / notifications | Devices listed / with a name | Page calls `getUserMedia`? | Request handler asked |
|---|---|---|---|---|
| no check handler | granted ×4 | 7 / 7 | yes → `NotAllowedError` | yes |
| check handler returns `false` (Koloft today, for a permission never asked) | denied ×4 | 3 / 0 | no: a page that checks first gives up | no |
| check handler returns `true` | granted ×4 | 7 / 7 | yes → `NotAllowedError` | yes |
| check handler `false` + preload patches `Permissions.prototype.query` (denied → prompt) | prompt ×4 | 3 / 0 | yes → `NotAllowedError` | yes |

- No variant made Chromium itself answer `prompt`: the check handler is a boolean (`electron.d.ts`: `=> boolean`), and with no handler everything reads granted.
- Answering `true` lets any page read device names (here 7 of 7, e.g. the Mac's microphone and camera names) before the person said yes to anything.
- The preload patch (done the way `src/preload/guest.ts` already patches the main world, `contextBridge.executeInMainWorld`) gives the Chrome-like answer without exposing device names.
- The check handler is also asked for `speaker-selection` on load.
- Not probed: a `<webview>` guest (Koloft's real case) instead of a `BrowserWindow`; an iframe (`permissionAsk` still refuses `isMainFrame === false`).

## The probe

`preload.js` (patched variant only):

```js
const { contextBridge } = require('electron')

contextBridge.executeInMainWorld({
  func: () => {
    const query = Permissions.prototype.query
    Permissions.prototype.query = async function (desc) {
      const status = await query.call(this, desc)
      if (status.state !== 'denied') return status
      Object.defineProperty(status, 'state', { get: () => 'prompt', configurable: true })
      return status
    }
  }
})
```

`main.js`:

```js
const { app, BrowserWindow, session } = require('electron')
const path = require('path')

app.commandLine.appendSwitch('use-fake-device-for-media-stream')
if (process.platform === 'darwin') app.setActivationPolicy('accessory')

async function probe(variant) {
  const ses = session.fromPartition('probe-' + variant)
  const checks = []
  const requests = []
  if (variant !== 'no-check-handler') {
    ses.setPermissionCheckHandler((_wc, permission, _origin, details) => {
      checks.push(`${permission}/${details && details.mediaType}`)
      return variant === 'check-true'
    })
  }
  ses.setPermissionRequestHandler((_wc, permission, cb) => {
    requests.push(permission)
    cb(false)
  })
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      session: ses,
      ...(variant === 'check-false-patched'
        ? { preload: path.join(__dirname, 'preload.js'), sandbox: false }
        : {})
    }
  })
  await win.loadFile(path.join(__dirname, 'page.html'))
  const out = await win.webContents.executeJavaScript('run()')
  win.destroy()
  return { variant, ...out, checks: [...new Set(checks)], requests }
}

app.whenReady().then(async () => {
  const row = await probe(process.env.PROBE_VARIANT)
  require('fs').writeFileSync(process.env.PROBE_OUT, JSON.stringify(row, null, 1))
  app.quit()
})
```

`page.html`:

```html
<!doctype html><title>p</title><script>
async function run() {
  const states = {}
  for (const n of ['microphone', 'camera', 'geolocation', 'notifications'])
    states[n] = (await navigator.permissions.query({ name: n })).state
  const devs = await navigator.mediaDevices.enumerateDevices()
  const labelled = devs.filter((d) => d.label).length
  if (states.microphone !== 'prompt' && states.microphone !== 'granted')
    return { states, devices: devs.length, labelled, gum: 'site gave up' }
  let gum
  try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop()); gum = 'granted' }
  catch (e) { gum = e.name }
  return { states, devices: devs.length, labelled, gum }
}
</script>
```

A second window in the same Electron process failed here (its renderer could not reach the main process: `bootstrap_look_up … MachPortRendezvousServer … Permission denied`), so each variant gets its own launch.
