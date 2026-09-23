import type { CSSProperties, JSX } from 'react'
import type { Folder } from '@shared/types'
import { DEFAULT_FOLDER_ICON, groupColorVars } from '@renderer/lib/groups'

/**
 * The one group glyph (design language v2 §9.37; the lead on #360: "one group glyph everywhere,
 * the tablet's 10 dot / 10 ring at a 2 stroke"), wherever a group is stood for by a mark: the
 * tablet's and the desktop's sidebar row, the phone overview's group card header and its
 * Departures ghost, the Groups pane's rows, the strip's chip, the swipe track's ribbon and a
 * sheet row's leading box. In the favicon's 16 box (`.zen-group-row-glyph`, main.css): a 10 dot
 * of the group's colour for an open group, the same 10 as a ring at a 2 stroke for a SAVED one
 * (its tabs closed, its pages kept – Chrome's filled and hollow marks), or the folder's own icon
 * where the desktop gave it one, a glyph at 14 that holds while text scales (§4). The colour is
 * §9.14's pair on the glyph itself (`groupColorVars`, `data-group-rgb`), so the theme's pick
 * recolours every one of them in the frame the tokens flip, and a glyph stands on any host
 * without the host carrying the pair for it. The own icon is drawn as generated content from
 * `data-icon` (`.zen-group-row-icon::before`), never as text: a glyph is no part of what a row
 * says, and the harness drivers read a sheet row or a header by its `textContent` – "Add to
 * Research (2)" stays "Add to Research (2)" with the folder's 📚 in the box beside it.
 */
export function GroupGlyph({
  folder,
  saved = false
}: {
  folder: Pick<Folder, 'icon' | 'color'>
  saved?: boolean
}): JSX.Element {
  const own = folder.icon && folder.icon !== DEFAULT_FOLDER_ICON ? folder.icon : null
  return (
    <span
      className="zen-group-row-glyph"
      data-saved={saved || undefined}
      data-testid="group-row-glyph"
      data-group-rgb=""
      style={groupColorVars(folder.color) as CSSProperties}
      aria-hidden
    >
      {own ? (
        <span className="zen-group-row-icon" data-icon={own} />
      ) : (
        <span className="zen-group-row-dot" />
      )}
    </span>
  )
}
