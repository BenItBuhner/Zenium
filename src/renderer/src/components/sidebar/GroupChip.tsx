import type { CSSProperties, JSX, ReactNode } from 'react'
import type { Folder } from '@shared/types'
import { groupColorChannels } from '@renderer/lib/groups'
import { cn } from '@renderer/lib/utils'
import { DEFAULT_FOLDER_ICON } from '../phone/GroupCard'

interface Props {
  folder: Folder
  /** Live tabs for an open group, the kept pages for a saved one. */
  count: number
  /** The group's tabs have closed and it keeps their pages (`Folder.savedTabs`, TAB-16). */
  saved: boolean
  /** The rail: the chip is its glyph alone. */
  compact: boolean
  /** The group's name, or the field editing it, in the chip's text slot. */
  children?: ReactNode
}

/**
 * A tab group's chip on the tablet sidebar (TABLET-04; Chrome's group header chip on the tab
 * strip): the group's colour as a pill in the folder row's leading slot – a 32 tall pill in the
 * colour's tint holding the group's glyph and its name at §9.36's 14 px – so a group reads as a
 * group among the rows, where the desktop row shows an 8 px dot beside a folder icon. The glyph
 * is a 10 px dot of the colour for an open group, a 2 px ring of it for a saved one (the Groups
 * pane's two states, `GroupGlyph`), or the folder's own icon where the desktop gave it one. A
 * collapsed group carries its count after the name, as does a saved one (its kept pages):
 * expanded, the rows below say it. `.zen-group-tag` in main.css draws the pill; the chip is
 * inert – the row around it is the target, its tap folding or unfolding the group (or opening a
 * saved one) and its hold the group's menu.
 */
export function GroupChip({ folder, count, saved, compact, children }: Props): JSX.Element {
  const own = folder.icon && folder.icon !== DEFAULT_FOLDER_ICON ? folder.icon : null
  return (
    <span
      className={cn('zen-group-tag', compact && 'zen-group-tag-glyph-only')}
      data-saved={saved || undefined}
      data-testid="group-chip"
      style={{ '--zen-group-rgb': groupColorChannels(folder.color) } as CSSProperties}
    >
      {own ? (
        <span className="zen-group-tag-icon" aria-hidden>
          {own}
        </span>
      ) : (
        <span className="zen-group-tag-dot" aria-hidden />
      )}
      {!compact && children}
      {!compact && (saved || folder.collapsed) && (
        <span className="zen-group-tag-count" data-testid="group-chip-count">
          {count}
        </span>
      )}
    </span>
  )
}
