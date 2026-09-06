import type { JSX } from 'react'
import type { UIState } from '@shared/types'
import type { UiState } from '@renderer/lib/ui'
import { AddonsPanel } from './AddonsPanel'
import { BookmarksPanel } from './BookmarksPanel'
import { BoostPanel } from './BoostPanel'
import { DownloadsPanel } from './DownloadsPanel'
import { HistoryPanel } from './HistoryPanel'
import { LiveFolderEditor } from './LiveFolderEditor'
import { SettingsPanel } from './SettingsPanel'
import { SpaceEditor } from './SpaceEditor'
import { ThemePicker } from './ThemePicker'

/** Renders whichever chrome overlay is open over the content area. */
export function OverlayHost({ state, ui }: { state: UIState; ui: UiState }): JSX.Element | null {
  switch (ui.overlay) {
    case 'settings':
      return <SettingsPanel state={state} />
    case 'shortcuts':
      return <SettingsPanel state={state} initialSection="shortcuts" />
    case 'sync':
      return <SettingsPanel state={state} initialSection="sync" />
    case 'history':
      return <HistoryPanel state={state} />
    case 'bookmarks':
      return <BookmarksPanel state={state} />
    case 'downloads':
      return <DownloadsPanel state={state} />
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
