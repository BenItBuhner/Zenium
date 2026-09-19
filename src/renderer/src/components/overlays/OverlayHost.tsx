import type { JSX } from 'react'
import type { UIState } from '@shared/types'
import { useViewport } from '@renderer/lib/formFactor'
import type { UiState } from '@renderer/lib/ui'
import { BookmarkManager } from '../bookmarks/BookmarkManager'
import { DownloadsSheet } from '../downloads/DownloadsSheet'
import { PhoneBookmarksPanel } from '../phone/PhoneBookmarksPanel'
import { PhoneHistoryPanel } from '../phone/PhoneHistoryPanel'
import { AddonsPanel } from './AddonsPanel'
import { BoostPanel } from './BoostPanel'
import { DownloadsPanel } from './DownloadsPanel'
import { HistoryPage } from './HistoryPage'
import { LiveFolderEditor } from './LiveFolderEditor'
import { SpaceEditor } from './SpaceEditor'
import { ThemePicker } from './ThemePicker'

/**
 * Renders whichever chrome overlay is open over the content area. Settings (with the Shortcuts
 * and Sync sections that used to retarget its overlay) is a page tab on every host
 * (`pages/settings`, design language v2 §10): `openOverlay` routes those kinds to `page.open`
 * before they reach the store, so no `settings | shortcuts | sync` case exists here.
 */
export function OverlayHost({ state, ui }: { state: UIState; ui: UiState }): JSX.Element | null {
  // History, bookmarks and downloads are lists a phone reads and touches differently (rows,
  // swipes, a selection header, a sheet); desktop and tablet keep their panels.
  const phone = useViewport().formFactor === 'phone'
  switch (ui.overlay) {
    case 'history':
      return phone ? <PhoneHistoryPanel state={state} /> : <HistoryPage state={state} />
    case 'bookmarks':
      return phone ? <PhoneBookmarksPanel state={state} /> : <BookmarkManager state={state} />
    case 'downloads':
      // A phone gets the sheet; a mouse (DeX, a tablet trackpad) and the desktop keep the
      // docked panel like the menus do.
      return phone ? <DownloadsSheet state={state} /> : <DownloadsPanel state={state} />
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
    default:
      return null
  }
}
