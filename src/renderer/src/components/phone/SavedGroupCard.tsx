import type { CSSProperties, JSX } from 'react'
import type { Folder, SavedGroupTab } from '@shared/types'
import { groupColorVars } from '@renderer/lib/groups'
import { groupRowLabel, type GroupRow } from '@renderer/lib/groupRows'
import { uiStore } from '@renderer/lib/ui'
import { GroupGlyph } from '../GroupGlyph'
import { GroupRename } from './GroupCard'
import { mosaicOf, MOSAIC_TILES } from './groupMosaic'
import { useLongPress } from './useLongPress'

/**
 * A SAVED group in the overview grid (`docs/tab-overview-cleanup-spec.md` §2; TAB-16): a group
 * whose tabs have closed but that kept their pages (`Folder.savedTabs`) stands at the grid's
 * end, before the New Tab card, as a card in the folded group's dress – the saved ring in the
 * header's glyph slot (`GroupGlyph saved`, §9.36), the name, the pages' count as the aside, and
 * a 2×2 mosaic of the pages it keeps: no captures to show, so each tile is the page's favicon
 * alone on the fill, as an open group's uncaptured member draws (`TabPreview tile`; never the
 * title at tile size, ruled on #731). A tap reopens the group (the owner's `folder.open`); a hold opens its sheet
 * (Open, Rename, Delete – `GroupRowSheet`), Rename editing the name in the header in place
 * (`GroupRename`, as the open group's card does). The card is the grid's cell `saved:<id>` for
 * the glide.
 */
export function SavedGroupCard({
  row,
  onOpen,
  onMenu
}: {
  row: GroupRow
  onOpen: (folder: Folder) => void
  onMenu: (row: GroupRow) => void
}): JSX.Element {
  const { folder } = row
  const pages = folder.savedTabs ?? []
  const renaming = uiStore.use((s) => s.renamingFolderId === folder.id)
  const press = useLongPress(() => onMenu(row))
  const open = (): void => {
    if (press.swallowsClick()) return
    onOpen(folder)
  }
  const { tiles, more } = mosaicOf(pages)
  const empty = Math.max(0, MOSAIC_TILES - tiles.length - (more > 0 ? 1 : 0))
  return (
    <div
      className="zen-group zen-group-saved flex flex-col"
      style={groupColorVars(folder.color) as CSSProperties}
      data-group-rgb=""
      data-cell={`saved:${folder.id}`}
      data-collapsed=""
      data-saved=""
    >
      <div
        role="button"
        tabIndex={0}
        aria-label={groupRowLabel(row)}
        className="zen-group-header flex shrink-0 items-center gap-2 pl-3 pr-2"
        data-testid="saved-group-card"
        onClick={open}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') open()
        }}
        {...press.handlers}
      >
        <GroupGlyph folder={folder} saved />
        {renaming ? (
          <GroupRename folder={folder} />
        ) : (
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
            {folder.name.trim()}
          </span>
        )}
        <span className="zen-group-row-count" data-testid="group-card-count">
          {row.count}
        </span>
      </div>
      <div className="zen-group-mosaic" aria-hidden data-testid="group-card-mosaic">
        {tiles.map((page, i) => (
          <SavedPageTile key={`${page.url}#${i}`} page={page} />
        ))}
        {more > 0 && (
          <div className="zen-group-tile zen-group-tile-more" data-tile="more">
            +{more}
          </div>
        )}
        {Array.from({ length: empty }, (_, i) => (
          <div
            key={`empty-${i}`}
            className="zen-group-tile zen-group-tile-empty"
            data-tile="empty"
          />
        ))}
      </div>
      <div
        className="zen-group-tap absolute inset-0"
        aria-hidden
        data-testid="group-card-tap"
        onClick={open}
        {...press.handlers}
      />
    </div>
  )
}

/**
 * A kept page as a tile: its favicon (or a quiet disc where none is kept) alone, centred on the
 * placeholder's fill – no title, no host (§2).
 */
function SavedPageTile({ page }: { page: SavedGroupTab }): JSX.Element {
  return (
    <div className="zen-group-tile zen-group-tile-page zen-tab-placeholder" data-tile={page.url}>
      {page.favicon ? (
        <img className="zen-group-tile-favicon" src={page.favicon} alt="" draggable={false} />
      ) : (
        <span className="zen-group-tile-favicon zen-group-tile-favicon-none" />
      )}
    </div>
  )
}
