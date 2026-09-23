import { useEffect, useState, type JSX } from 'react'
import { LuMinus, LuPlus } from 'react-icons/lu'
import { clampFontSize } from '@shared/settingsOps'
import { useStore } from '../../store'
import { Switch } from './Switch'
import { useSettingsUpdate } from './useSettingsUpdate'

// a few common monospace / Nerd Font families to offer as quick picks (FR-08: the
// full FONT_SUGGESTIONS set, presented as chips instead of a datalist)
const FONT_SUGGESTIONS = [
  'JetBrainsMono Nerd Font',
  'MesloLGS NF',
  'FiraCode Nerd Font',
  'Hack Nerd Font',
  'CaskaydiaCove Nerd Font',
  'Menlo',
  'Monaco'
]

/** Appearance = "Terminal font" + "Session display" (the four-category
 *  decision): everything about how terminals and session rows look. */
export function AppearancePane(): JSX.Element {
  const settings = useStore((s) => s.settings)
  const update = useSettingsUpdate()
  // fontSize edits go through a draft so a user can TYPE "13" without the clamp
  // eating the intermediate "1"; the clamped value commits on blur/Enter, so an
  // out-of-range size never persists (FR-08 edge case)
  const [sizeDraft, setSizeDraft] = useState(String(settings.fontSize))
  useEffect(() => setSizeDraft(String(settings.fontSize)), [settings.fontSize])

  const commitSize = (raw: string | number): void => {
    const v = clampFontSize(raw)
    setSizeDraft(String(v))
    if (v !== settings.fontSize) update({ fontSize: v })
  }

  return (
    <>
      <div className="set-ph">
        <h3>Appearance</h3>
        <p>Terminal fonts, and how Claude sessions present themselves.</p>
      </div>

      <div className="set-grp">Terminal font</div>
      <div className="set-row stack">
        <div className="set-lab">
          <b>Font family</b>
          <small>
            Comma-separated CSS stack. Put a Nerd Font first so powerline / git / icon glyphs render
            (no more □ boxes).
          </small>
        </div>
        <input
          className="set-input"
          type="text"
          value={settings.fontFamily}
          onChange={(e) => update({ fontFamily: e.target.value })}
          spellCheck={false}
        />
        <div className="font-chips">
          {FONT_SUGGESTIONS.map((f) => (
            <button key={f} className="chip" onClick={() => update({ fontFamily: f })}>
              {f}
            </button>
          ))}
        </div>
      </div>

      <div className="set-row">
        <div className="set-lab">
          <b>Font size</b>
          <small>8 – 32 px.</small>
        </div>
        <div className="set-stepper">
          <button aria-label="Smaller" onClick={() => commitSize(settings.fontSize - 1)}>
            <LuMinus size={13} />
          </button>
          <input
            type="number"
            min={8}
            max={32}
            aria-label="Font size"
            value={sizeDraft}
            onChange={(e) => setSizeDraft(e.target.value)}
            onBlur={() => commitSize(sizeDraft)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitSize(sizeDraft)
            }}
          />
          <button aria-label="Larger" onClick={() => commitSize(settings.fontSize + 1)}>
            <LuPlus size={13} />
          </button>
        </div>
      </div>

      <div className="set-row stack">
        <div className="set-lab">
          <b>Preview</b>
          <small>
            Rendered with the stack above, at the size above — what you see is what the terminal
            gets.
          </small>
        </div>
        <div
          className="font-preview"
          style={{ fontFamily: settings.fontFamily, fontSize: settings.fontSize }}
        >
          <span className="g">❯</span> ~/Projects/app <span className="a">⎇ main ±2</span> npm run
          dev <span className="d">· ✔ built in 1.2s</span> <span className="cur" />
        </div>
      </div>

      <div className="set-grp">Session display</div>
      <div className="set-row">
        <div className="set-lab">
          <b>Show cost &amp; context usage</b>
          <small>
            Adds a second line to each Claude session — a context-window ring, percent, and running
            cost (an estimate). Off returns rows to a single line.
          </small>
        </div>
        <Switch checked={settings.showUsage} onChange={(on) => update({ showUsage: on })} />
      </div>
      <div className="set-row">
        <div className="set-lab">
          <b>Built-in Claude statusline</b>
          <small>
            Renders Koloft&rsquo;s bundled <code>ccstatusline</code> under the prompt of every
            Claude session started in a tab, overriding your own <code>statusLine</code> setting for
            that session. Applies to newly started sessions; off leaves your own settings in charge.
          </small>
        </div>
        <Switch
          checked={settings.statuslineBuiltin}
          onChange={(on) => update({ statuslineBuiltin: on })}
        />
      </div>
      <div className="set-row">
        <div className="set-lab">
          <b>Auto-fetch git remotes</b>
          <small>
            Runs <code>git fetch</code> for each workspace in the background so the sidebar can show
            how far the checkout is behind. Off stops every automatic fetch — the workspace
            menu&rsquo;s <i>Fetch origin</i> still works on demand.
          </small>
        </div>
        <Switch checked={settings.gitAutoFetch} onChange={(on) => update({ gitAutoFetch: on })} />
      </div>
    </>
  )
}
