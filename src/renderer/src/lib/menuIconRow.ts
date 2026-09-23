import type { MenuItemDescriptor } from '@shared/types'

/**
 * The phone app menu's icon row (matrix TB-08): a group of a renderer-drawn menu whose items all
 * name a glyph is Chrome's row of icon buttons – Forward, Home while a homepage is set, the star,
 * Download page, Page info, Reload / Stop – rather than rows of text (`MenuSheet`). The core
 * names the glyphs (`src/core/menus.ts`); a group with one text row among them is rows, as any
 * other.
 */
export function isIconRow(group: MenuItemDescriptor[]): boolean {
  return group.length > 0 && group.every((item) => item.glyph !== undefined)
}
