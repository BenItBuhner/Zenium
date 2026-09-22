import { MENU_PANEL_INSET } from '@renderer/lib/portals'

/*
 * Geometry of the bookmarks bar's cascading folder panels (design-language-v2-draft §5 menus,
 * §9.20 placement). The root panel hangs from its chip through `placePopover`; a nested panel
 * stands beside the panel that holds its folder's row through `placeBeside` – `placePopover`'s
 * cascade mode in lib/portals.tsx, which this file first carried (with the DOM readers
 * `layoutRect` and `rowRect` that feed it) and now re-exports for its callers and tests.
 */

export {
  CASCADE_OVERLAP,
  besideOrigin,
  layoutRect,
  placeBeside,
  rowRect,
  type BesideEdge
} from '@renderer/lib/portals'

/**
 * The distance from a menu panel's outer top edge to its first row: the 1 px border and the
 * `.zen-v2-menu` 6 px padding – the chassis' `MENU_PANEL_INSET`. A nested panel is offset by it
 * so its first row lines up with the folder row that opened it, as Chrome's and Firefox's
 * submenus do.
 */
export const PANEL_INSET = MENU_PANEL_INSET
