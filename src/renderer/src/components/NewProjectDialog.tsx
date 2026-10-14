import { BACKEND_LABEL } from '@shared/sessionBackend'
import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { LuSparkles, LuX } from 'react-icons/lu'
import type { BackendId } from '@shared/types'
import { LOCAL_MACHINE } from '@shared/sessionRoute'
import { isValidWorktreeName } from '@shared/worktreeName'
import { projectOptions } from '../aiStart'
import { shortenHome } from '../browseModel'
import { isComposing } from '../keys'
import { remoteKeyFromForm } from '../remoteWorkspace'
import { useStore } from '../store'
import { SeedFields } from './SeedFields'
import { updateSettings } from './settings/useSettingsUpdate'
import {
  BusyLine,
  enterMethod,
  otherMethods,
  SessionLaunchButtons,
  SessionLaunchStatus,
  useSessionLaunch,
  type StartSession
} from './SessionLaunchButtons'

export interface ProjectSeed {
  prompt: string
  title: string
  machine: string
  folder: string
  why: string
}

export function NewProjectDialog({
  seed,
  launchLock,
  onClose,
  onStart,
  onChangeWorkspace
}: {
  seed: ProjectSeed
  launchLock: { current: boolean }
  onClose: () => void
  onStart: StartSession
  onChangeWorkspace: (typed: { prompt: string; title: string }) => void
}): JSX.Element {
  const { machine } = seed
  const local = machine === LOCAL_MACHINE
  const folders = useStore((s) => s.settings.newProjectFolders)
  const [folder, setFolder] = useState(seed.folder)
  const [parent, setParent] = useState(folders[machine] ?? '')
  const [title, setTitle] = useState(seed.title)
  const [prompt, setPrompt] = useState(seed.prompt)
  const folderRef = useRef<HTMLInputElement>(null)
  const sessionLaunch = useSessionLaunch(local ? 'local' : 'ssh', onStart, onClose)
  const locked = sessionLaunch.starting
  useEffect(() => {
    launchLock.current = locked
    return () => {
      launchLock.current = false
    }
  }, [locked, launchLock])

  useEffect(() => {
    folderRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape' && !locked) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [locked, onClose])

  const name = folder.trim()
  const where = parent.trim().replace(/\/+$/, '')
  const nameBad = !!name && !isValidWorktreeName(name)
  const remote = local || !where ? null : remoteKeyFromForm(machine, where)
  const whereBad = remote?.ok === false ? remote.message : ''
  const parentKey = remote?.ok ? remote.key : where
  const ready = !!name && !nameBad && !!where && !whereBad
  const backends = sessionLaunch.usable
  const others = otherMethods(backends, sessionLaunch.methods.defaultBackend)

  const submit = (backend: BackendId = sessionLaunch.methods.defaultBackend): void => {
    if (!ready || locked || sessionLaunch.issue(backend)) return
    void sessionLaunch.launch(async () => {
      const opts = await projectOptions(parentKey, name, { prompt, title })
      updateSettings({ newProjectFolders: { ...folders, [machine]: where } })
      return opts
    }, backend)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    if (locked || e.key !== 'Enter' || isComposing(e)) return
    e.preventDefault()
    submit(enterMethod(e, others))
  }

  const pick = async (): Promise<void> => {
    const picked = await window.api.workspace.pickFolder()
    if (picked) setParent(picked)
  }

  const shownWhere = local && where ? shortenHome(where, window.api.home) : where

  return (
    <div className="modal-backdrop" onClick={() => !locked && onClose()}>
      <div
        className="modal worktreesess"
        role="dialog"
        aria-label="New Project"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span>New Project</span>
          <span className="modal-close" onClick={() => !locked && onClose()} aria-label="Close">
            <LuX size={16} />
          </span>
        </div>
        <div className="modal-body">
          <p className="field-hint assist-why">
            <LuSparkles size={13} className="assist-glyph" />
            <span>{seed.why || 'No workspace fits — make a new one.'}</span>
            <button
              className="ob-link"
              disabled={locked}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onChangeWorkspace({ prompt, title })}
            >
              Change workspace
            </button>
          </p>
          <span className="flabel">Folder name</span>
          <div className="cb-input focus">
            <input
              ref={folderRef}
              className="cb-field"
              spellCheck={false}
              autoComplete="off"
              aria-label="Folder name"
              disabled={locked}
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              onKeyDown={onKeyDown}
            />
          </div>
          {nameBad && <p className="field-hint bad">Only letters, digits, . _ -</p>}
          <span className="flabel">In</span>
          <div className="cb-input project-in">
            {!local && <span className="ws-remote">{machine}</span>}
            <input
              className="cb-field"
              spellCheck={false}
              autoComplete="off"
              aria-label="In"
              placeholder={local ? 'No folder picked yet' : '/home/me/projects'}
              readOnly={local}
              disabled={locked}
              value={local ? shownWhere : parent}
              onChange={(e) => setParent(e.target.value)}
              onKeyDown={onKeyDown}
            />
            {local && (
              <button
                className="mini"
                disabled={locked}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void pick()}
              >
                Choose folder…
              </button>
            )}
          </div>
          {whereBad ? (
            <p className="field-hint bad">{whereBad}</p>
          ) : !where ? (
            <p className="field-hint warn">
              Pick where new projects go{local ? '' : ` on ${machine}`}. Koloft remembers it for
              next time.
            </p>
          ) : (
            ready && (
              <p className="field-hint">
                Make the folder <code>{`${shownWhere}/${name}`}</code>, add it as a workspace, and
                start the session in it.
              </p>
            )
          )}
          <SeedFields
            title={title}
            prompt={prompt}
            onTitle={setTitle}
            onPrompt={setPrompt}
            onKeyDown={onKeyDown}
            disabled={locked}
          />
          {locked && <BusyLine>Starting…</BusyLine>}
          <SessionLaunchStatus launch={sessionLaunch} />
        </div>
        <div className="modal-foot">
          <button
            className="mini"
            disabled={locked}
            onMouseDown={(e) => e.preventDefault()}
            onClick={onClose}
          >
            Cancel
          </button>
          <SessionLaunchButtons
            launch={sessionLaunch}
            backends={backends}
            busy={locked}
            disabled={!ready || locked}
            label={(backend) =>
              locked
                ? 'Starting…'
                : backends.length > 1
                  ? `Create project · ${BACKEND_LABEL[backend]}`
                  : 'Create project'
            }
            onStart={submit}
          />
        </div>
      </div>
    </div>
  )
}
