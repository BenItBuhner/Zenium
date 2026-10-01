import type { JSX } from 'react'
import { Plus } from 'lucide-react'
import type { UIState } from '@shared/types'
import { OVERVIEW_LABELS } from '@shared/overviewMenu'
import { run } from '@renderer/lib/api'
import { overviewTabCount, spaceSwatch, tabsWord } from '@renderer/lib/overviewHeader'
import { activeTab } from '@renderer/lib/selectors'
import { openOverlay } from '@renderer/lib/ui'
import { SpaceGlyph } from '../SpaceGlyph'
import { OverviewSheet, type SheetAction } from './OverviewSheet'

interface Props {
  state: UIState
  isDark: boolean
  onClose: () => void
}

/**
 * The Spaces sheet (tab overview cleanup spec §1): what the overview's title opens – the Spaces
 * drawer's rows as a §9.23 sheet. Each space a row with its dot (the theme's accent, as the
 * drawer draws it), its name and the count the overview's header would show for it; the
 * current one checked (`aria-current`); "New Space…" last, the space editor. A pick of another
 * space asks the core to switch (`space.activate`) once the sheet is gone – the overview's
 * title and grid follow as the pane swipe's do; a pick of the current one just closes.
 */
export function SpacesSheet({ state, isDark, onClose }: Props): JSX.Element {
  const active = activeTab(state)
  const actions: SheetAction[] = state.spaces.map((space) => ({
    id: `space:${space.id}`,
    label: space.name,
    icon: <SpaceGlyph icon={space.icon} size={20} dotColor={spaceSwatch(space, isDark)} />,
    trailing: tabsWord(overviewTabCount(state, space)),
    current: space.id === state.activeSpaceId,
    testId: 'spaces-sheet-space',
    onPick: () => {
      if (space.id !== state.activeSpaceId) run('space.activate', { spaceId: space.id })
    }
  }))
  actions.push({
    id: 'new-space',
    label: OVERVIEW_LABELS.newSpace,
    icon: <Plus className="h-5 w-5" aria-hidden />,
    testId: 'spaces-sheet-new',
    onPick: () => void openOverlay('space-editor', active?.id ?? null, null)
  })
  return <OverviewSheet title={OVERVIEW_LABELS.spaces} actions={actions} onClose={onClose} />
}
