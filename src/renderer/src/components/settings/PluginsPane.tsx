import { useState, type JSX } from 'react'
import type { PluginManifest } from '@core/plugin'
import type { PluginState } from '@core/switches'
import { PLUGINS } from '@plugins/list'
import { PLUGIN_SETTINGS_PAGES } from '@shared/paletteFeatures'
import { PLUGINS_PANE_NAME } from '@shared/settingsPanes'
import { IconChevronLeft, IconChevronRight } from '../../icons'
import { fillsOf, partsAt } from '../../pluginUi'
import { setPluginOn, useDoes, useNeverSetUp, usePluginStates } from '../../pluginSwitches'
import { PLUGIN_SET_UP, type PluginSetUp } from '../../slots'
import { useStore } from '../../store'
import { useAssistSetup } from '../../useAssistSetup'
import { AssistRow } from './AssistSection'
import { pluginPane, useSettingsGo } from './settingsNav'
import { Switch } from './Switch'
import { useSettingsUpdate } from './useSettingsUpdate'

const byId = (id: string): PluginManifest => PLUGINS.find((p) => p.id === id)!

function namesInASentence(names: readonly string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

function NeedsLine({ plugin, state }: { plugin: PluginManifest; state: PluginState }) {
  if (!plugin.needs.length) return null
  const needs = namesInASentence(plugin.needs.map((id) => byId(id).name))
  return (
    <small>
      Needs {needs}.{state.offBecause && ` ${state.offBecause.name} is off.`}
    </small>
  )
}

function PluginSwitch({
  plugin,
  state,
  ariaLabel
}: {
  plugin: PluginManifest
  state: PluginState
  ariaLabel: string
}): JSX.Element {
  const need = state.offBecause
  return (
    <Switch
      checked={state.on}
      disabled={!!need}
      ariaLabel={ariaLabel}
      title={
        need
          ? `Turn on ${need.name} before turning ${plugin.name} on`
          : `Turn ${plugin.name} ${state.on ? 'off' : 'on'}`
      }
      onChange={(on) => setPluginOn(plugin.id, on)}
    />
  )
}

function SetUpButton({
  setUp,
  onError
}: {
  setUp: PluginSetUp
  onError: (error: string) => void
}): JSX.Element {
  const label = setUp.useLabel()
  return (
    <button
      className="mini"
      onClick={() =>
        void setUp.run().then(
          (e) => onError(e ?? ''),
          (e: unknown) => onError(String(e))
        )
      }
    >
      {label}
    </button>
  )
}

function PluginRow({ plugin, state }: { plugin: PluginManifest; state: PluginState }) {
  const go = useSettingsGo()
  const does = useDoes(plugin)
  const neverSetUp = useNeverSetUp(plugin)
  const setUp = fillsOf(PLUGIN_SET_UP).find((f) => f.plugin === plugin.id)
  const [error, setError] = useState('')
  return (
    <>
      <div className="set-row">
        <div className="set-lab">
          <b>{plugin.name}</b>
          <small>{does}</small>
          <NeedsLine plugin={plugin} state={state} />
        </div>
        {plugin.mandatory ? (
          <span className="acct-note">Always on</span>
        ) : (
          <>
            {setUp && neverSetUp && <SetUpButton setUp={setUp} onError={setError} />}
            <PluginSwitch plugin={plugin} state={state} ariaLabel={plugin.name} />
          </>
        )}
        <button
          className="icobtn"
          title="Open"
          aria-label={`Open ${plugin.name}`}
          onClick={() => go(pluginPane(plugin.id))}
        >
          <IconChevronRight size={14} />
        </button>
      </div>
      {error && <div className="acct-login-state bad">{error}</div>}
    </>
  )
}

export function PluginsPane(): JSX.Element {
  const agentTools = useStore((s) => s.settings.agentTools)
  const update = useSettingsUpdate()
  const states = usePluginStates()
  const rows = (mandatory: boolean): JSX.Element[] =>
    PLUGINS.filter((p) => p.mandatory === mandatory).map((p) => (
      <PluginRow key={p.id} plugin={p} state={states[p.id]} />
    ))
  return (
    <>
      <div className="set-ph">
        <h3>{PLUGINS_PANE_NAME}</h3>
        <p>
          Each part of Koloft is a plugin. Turning one off takes away everything it adds — its text
          for agents, its commands, its buttons. Its settings stay, so turning it on again finds
          them.
        </p>
      </div>

      <div className="set-row">
        <div className="set-lab">
          <b>Let agents use Koloft</b>
          <small>
            A session&apos;s agent gets a koloft command: it can open files and pages in its
            Workbench, read and add to the note, manage scheduled tasks and start sibling sessions.
            A toast tells you when it changes a scheduled task. Turning this on reaches sessions
            started afterwards; turning it off stops the command in every session at once.
          </small>
        </div>
        <Switch checked={agentTools} onChange={(on) => update({ agentTools: on })} />
      </div>

      <div className="set-grp">Always on</div>
      {rows(true)}
      <div className="set-grp">Optional</div>
      {rows(false)}
    </>
  )
}

export function PluginPage({ id }: { id: string }): JSX.Element {
  const plugin = byId(id)
  const go = useSettingsGo()
  const state = usePluginStates()[id]
  const does = useDoes(plugin)
  const setup = useAssistSetup()
  const page = PLUGIN_SETTINGS_PAGES.find((p) => p.plugin === id)
  const Part = page && partsAt('settings-page').find((p) => p.id === page.id)!.Part
  const jobs = plugin.assistJobs ?? []
  return (
    <>
      <button className="mini set-back" onClick={() => go('plugins')}>
        <IconChevronLeft size={14} />
        {PLUGINS_PANE_NAME}
      </button>
      <div className="set-ph">
        <h3>{plugin.name}</h3>
        <p>{does}</p>
      </div>
      {plugin.mandatory ? (
        <div className="set-row">
          <div className="set-lab">
            <b>Always on</b>
            <small>Other parts of Koloft are built on it, so it has no switch.</small>
            <NeedsLine plugin={plugin} state={state} />
          </div>
        </div>
      ) : (
        <div className="set-row">
          <div className="set-lab">
            <b>Turn on {plugin.name}</b>
            <small>
              Its commands and buttons go at once; its text for agents goes from sessions started
              afterwards.
            </small>
            <NeedsLine plugin={plugin} state={state} />
          </div>
          <PluginSwitch plugin={plugin} state={state} ariaLabel={`Turn on ${plugin.name}`} />
        </div>
      )}
      {jobs.length > 0 && (
        <>
          <div className="set-grp">Small jobs</div>
          {jobs.map((job) => (
            <AssistRow key={job.id} row={job.id} title={job.name} does={job.does} setup={setup} />
          ))}
        </>
      )}
      {Part && <Part />}
    </>
  )
}
