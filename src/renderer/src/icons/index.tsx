import type { ReactNode, SVGProps } from 'react'
import { ICON_PATHS } from './paths'

type IconProps = Omit<SVGProps<SVGSVGElement>, 'ref'> & { size?: number | string }
export type Icon = (props: IconProps) => ReactNode

const TURN_LEFT = 'rotate(90 12 12)'
const TURN_RIGHT = 'rotate(-90 12 12)'
const TURN_OVER = 'rotate(180 12 12)'
const MIRROR = 'matrix(-1 0 0 1 24 0)'

function icon(name: keyof typeof ICON_PATHS, transform?: string): Icon {
  const d = ICON_PATHS[name]
  return function KoloftIcon({ size = '1em', ...rest }) {
    return (
      <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" {...rest}>
        <path d={d} fillRule="evenodd" transform={transform} />
      </svg>
    )
  }
}

export const IconAccounts = icon('accounts')
export const IconAddProject = icon('addProject')
export const IconAiStart = icon('aiStart')
export const IconAppearance = icon('appearance')
export const IconAssist = icon('assist')
export const IconBack = icon('back')
export const IconBlocked = icon('blocked')
export const IconBranch = icon('branch')
export const IconCamera = icon('camera')
export const IconCheck = icon('check')
export const IconChevronDown = icon('chevronDown')
export const IconChevronLeft = icon('chevronDown', TURN_LEFT)
export const IconChevronRight = icon('chevronDown', TURN_RIGHT)
export const IconChevronUp = icon('chevronDown', TURN_OVER)
export const IconClipboard = icon('clipboard')
export const IconClose = icon('close')
export const IconCommit = icon('commit')
export const IconCopy = icon('copy')
export const IconCopyLink = icon('copyLink')
export const IconDelete = icon('delete')
export const IconDownload = icon('download')
export const IconEdit = icon('edit')
export const IconExpand = icon('expand')
export const IconExtensions = icon('extensions')
export const IconFile = icon('file')
export const IconFiles = icon('files')
export const IconFolder = icon('folder')
export const IconFolderOpen = icon('folderOpen')
export const IconForward = icon('back', MIRROR)
export const IconInfo = icon('info')
export const IconIssue = icon('issue')
export const IconKeepAwake = icon('keepAwake')
export const IconLinkOut = icon('linkOut')
export const IconLoading = icon('loading')
export const IconLocation = icon('location')
export const IconMicrophone = icon('microphone')
export const IconMinus = icon('minus')
export const IconMore = icon('more')
export const IconNewPullRequest = icon('newPullRequest')
export const IconNewWorktree = icon('newWorktree')
export const IconNotes = icon('notes')
export const IconNotifications = icon('notifications')
export const IconOpenOutside = icon('openOutside')
export const IconOwnerAsleep = icon('ownerAsleep')
export const IconOpenedPage = icon('openedPage')
export const IconOutline = icon('outline')
export const IconPickElement = icon('pickElement')
export const IconPin = icon('pin')
export const IconPlay = icon('play')
export const IconPlus = icon('plus')
export const IconPullRequest = icon('pullRequest')
export const IconPush = icon('push')
export const IconReload = icon('reload')
export const IconScheduled = icon('scheduled')
export const IconSearch = icon('search')
export const IconSend = icon('send')
export const IconSettings = icon('settings')
export const IconShortcuts = icon('shortcuts')
export const IconShrink = icon('shrink')
export const IconSidebarLeft = icon('sidebarLeft')
export const IconSidebarRight = icon('sidebarRight')
export const IconSignIn = icon('signIn')
export const IconSoundOff = icon('soundOff')
export const IconSoundOn = icon('soundOn')
export const IconStar = icon('star')
export const IconTerminal = icon('terminal')
export const IconUpdate = icon('update')
export const IconUsage = icon('usage')
export const IconWarning = icon('warning')
export const IconWebPage = icon('webPage')
