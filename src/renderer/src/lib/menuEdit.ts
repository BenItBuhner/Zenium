import { MENU_KEY_CHANGE_MENU, menuOrderOf, moveMenuItem } from '@shared/menuOrder'
import type { MenuItemDescriptor } from '@shared/types'
import { isIconRow } from './menuIconRow'

/**
 * The phone app menu's root as its edit mode (Change Menu, TB-22; `MenuSheet.tsx`) works on it.
 * The core composes the root as the icon row, a hairline, the list – rows and the hairlines
 * between their groups, every one of them keyed (`shared/menuOrder.ts`) – then a hairline and
 * the Change Menu row. The two keyed runs are the sections the edit mode moves items within,
 * each on its own: the row keeps its membership and its place at the head (§9.13), the list
 * reorders as one list, its hairlines slots like its rows, so a row dragged past a hairline
 * joins the next group. The unkeyed hairlines and the Change Menu row are the structure around
 * them: drawn in the normal pose, kept out of the edit pose and out of the saved order.
 */
export interface MenuSections {
  row: MenuItemDescriptor[]
  /** The hairline between the row and the list, when the core drew one. */
  rowEnd: MenuItemDescriptor | null
  list: MenuItemDescriptor[]
  /** The Change Menu row, with the hairline before it; empty for a menu without one. */
  change: MenuItemDescriptor[]
}

export type MenuSection = 'row' | 'list'

/** Whether `item` is the Change Menu row, whose pick opens the edit mode in place. */
export function isChangeMenuItem(item: MenuItemDescriptor): boolean {
  return item.key === MENU_KEY_CHANGE_MENU
}

/** Whether a menu's root has an edit mode to offer: the Change Menu row is there to open it. */
export function editableMenu(items: readonly MenuItemDescriptor[]): boolean {
  return items.some(isChangeMenuItem)
}

/** The root's items cut into the sections above (`joinMenuSections` puts them back). */
export function splitMenuSections(items: readonly MenuItemDescriptor[]): MenuSections {
  let end = items.length
  const change: MenuItemDescriptor[] = []
  const last = items[end - 1]
  if (last && isChangeMenuItem(last)) {
    change.unshift(last)
    end -= 1
    const before = items[end - 1]
    if (before && before.type === 'separator' && before.key === undefined) {
      change.unshift(before)
      end -= 1
    }
  }
  const body = items.slice(0, end)
  let firstSep = body.findIndex((item) => item.type === 'separator')
  if (firstSep < 0) firstSep = body.length
  const head = body.slice(0, firstSep)
  if (!isIconRow(head)) return { row: [], rowEnd: null, list: body, change }
  const rowEnd = body[firstSep]
  return {
    row: head,
    rowEnd: rowEnd && rowEnd.key === undefined ? rowEnd : null,
    list: body.slice(rowEnd && rowEnd.key === undefined ? firstSep + 1 : firstSep),
    change
  }
}

/** The sections as one root again, in the order the sheet draws. */
export function joinMenuSections(sections: MenuSections): MenuItemDescriptor[] {
  return [
    ...sections.row,
    ...(sections.rowEnd ? [sections.rowEnd] : []),
    ...sections.list,
    ...sections.change
  ]
}

/** The keys of both sections in their order: what Done saves as `settings.menuOrder`. */
export function menuSectionsOrder(sections: MenuSections): string[] {
  return menuOrderOf([...sections.row, ...sections.list], (item) => item.key)
}

/** The section `key` is in, or null for a key of neither (the structure's items have none). */
export function menuSectionOf(sections: MenuSections, key: string): MenuSection | null {
  if (sections.row.some((item) => item.key === key)) return 'row'
  if (sections.list.some((item) => item.key === key)) return 'list'
  return null
}

/** `sections` with the item at `from` of `section` moved to `to` (`moveMenuItem`'s rule). */
export function moveMenuSectionItem(
  sections: MenuSections,
  section: MenuSection,
  from: number,
  to: number
): MenuSections {
  return { ...sections, [section]: moveMenuItem(sections[section], from, to) }
}

/**
 * `sections` with the item `key` moved by `step` slots within its section (the accessibility
 * actions: Move up is −1, Move down +1), or to the section's start (`step` = `'start'`);
 * unchanged for a key of neither section or a move off either end.
 */
export function nudgeMenuItem(
  sections: MenuSections,
  key: string,
  step: 1 | -1 | 'start'
): MenuSections {
  const section = menuSectionOf(sections, key)
  if (!section) return sections
  const from = sections[section].findIndex((item) => item.key === key)
  const to = step === 'start' ? 0 : from + step
  if (to < 0 || to >= sections[section].length || to === from) return sections
  return moveMenuSectionItem(sections, section, from, to)
}

/** Whether the two roots list the same items in the same order (by id). */
export function sameMenuOrder(
  a: readonly MenuItemDescriptor[],
  b: readonly MenuItemDescriptor[]
): boolean {
  return a.length === b.length && a.every((item, i) => item.id === b[i]?.id)
}

/**
 * The items of a section that the edit mode counts as positions – its rows and buttons, not
 * its hairlines – so "3 of 12" reads over what the user sees, and `positionOf` the item's place
 * among them (1-based; 0 for a hairline).
 */
export function countedItems(section: readonly MenuItemDescriptor[]): MenuItemDescriptor[] {
  return section.filter((item) => item.type !== 'separator')
}

export function positionOf(section: readonly MenuItemDescriptor[], key: string): number {
  return countedItems(section).findIndex((item) => item.key === key) + 1
}
