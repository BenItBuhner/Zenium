import type { JSX } from 'react'
import type { UIState } from '@shared/types'
import type { UiState } from '@renderer/lib/ui'
import { BookmarksPanel } from './BookmarksPanel'
import { DownloadsPanel } from './DownloadsPanel'
import { HistoryPanel } from './HistoryPanel'
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
    default:
      return null
  }
}
