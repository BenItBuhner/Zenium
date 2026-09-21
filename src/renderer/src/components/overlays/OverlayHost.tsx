import type { JSX } from 'react'
import type { UIState } from '@shared/types'
import type { UiState } from '@renderer/lib/ui'
import { DownloadsSheet } from '../downloads/DownloadsSheet'
import { PhoneBookmarksPanel } from '../phone/PhoneBookmarksPanel'
import { PhoneHistoryPanel } from '../phone/PhoneHistoryPanel'
import { AddonsPanel } from './AddonsPanel'
import { BoostPanel } from './BoostPanel'
import { LiveFolderEditor } from './LiveFolderEditor'
import { PasswordsPanel } from './passwords/PasswordsPanel'
import { SpaceEditor } from './SpaceEditor'
import { ThemePicker } from './ThemePicker'

/**
 * Renders whichever chrome overlay is open over the content area. Settings (with the Shortcuts
 * and Sync sections that used to retarget its overlay) is a page tab on every host
 * (`pages/settings`, design language v2 §10): `openOverlay` routes those kinds to `page.open`
 * before they reach the store, so no `settings | shortcuts | sync` case exists here. History,
 * the bookmarks manager and Downloads are page tabs on the desktop and tablet layouts
 * (`pages/InternalPageHost`, v2 §10.1) and reach this host only as the phone's panels and
 * sheet – lists a finger reads and touches differently (rows, swipes, a selection header).
 */
export function OverlayHost({ state, ui }: { state: UIState; ui: UiState }): JSX.Element | null {
  switch (ui.overlay) {
    case 'history':
      return <PhoneHistoryPanel state={state} />
    case 'bookmarks':
      return <PhoneBookmarksPanel state={state} />
    case 'downloads':
      return <DownloadsSheet state={state} />
    case 'theme':
      return <ThemePicker state={state} spaceId={ui.overlaySpaceId ?? state.activeSpaceId} />
    case 'space-editor':
      return <SpaceEditor state={state} spaceId={ui.overlaySpaceId} />
    case 'boosts':
      return <BoostPanel state={state} />
    case 'addons':
      return <AddonsPanel state={state} />
    case 'live-folder':
      return <LiveFolderEditor state={state} folderId={ui.overlayFolderId} />
    case 'passwords':
      return <PasswordsPanel state={state} />
    default:
      return null
  }
}
