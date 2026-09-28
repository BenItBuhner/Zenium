import {
  MENU_KEY_CHANGE_MENU,
  MENU_KEY_MANAGED,
  MENU_KEY_UPDATE,
  menuOrderOf,
  moveMenuItem
} from '@shared/menuOrder'
import type { MenuItemDescriptor } from '@shared/types'
import { isIconRow } from './menuIconRow'

/**
 * The phone app menu's root as its edit mode (Change Menu, TB-22; `MenuSheet.tsx`) works on it.
 * The core composes the root as the icon row, a hairline, the Update Zenium row with a hairline
 * under it while an update waits (TB-12), the list – rows and the hairlines between their
 * groups, every one of them keyed (`shared/menuOrder.ts`) – then a hairline and the Change Menu
 * row, and last, while the browser is managed, a hairline and the Managed Browser row (TB-13).
 * The two keyed runs are the sections the edit mode moves items within, each on its own: the
 * row keeps its membership and its place at the head (§9.13), the list reorders as one list,
 * its hairlines slots like its rows, so a row dragged past a hairline joins the next group.
 * The unkeyed hairlines, the update row, the Change Menu row and the Managed Browser row are
 * the structure around them: drawn in the normal pose, kept out of the edit pose and out of
 * the saved order.
 */
export interface MenuSections {
  row: MenuItemDescriptor[]
  /** The hairline between the row and the list, when the core drew one. */
  rowEnd: MenuItemDescriptor | null
  /** The Update Zenium row, with the hairline after it; empty while no update waits. */
  update: MenuItemDescriptor[]
  list: MenuItemDescriptor[]
  /** The Change Menu row, with the hairline before it; empty for a menu without one. */
  change: MenuItemDescriptor[]
  /** The Managed Browser row, with the hairline before it; empty for an unmanaged browser. */
  managed: MenuItemDescriptor[]
}

export type MenuSection = 'row' | 'list'

/** Whether `item` is the Change Menu row, whose pick opens the edit mode in place. */
export function isChangeMenuItem(item: MenuItemDescriptor): boolean {
  return item.key === MENU_KEY_CHANGE_MENU
}

/** Whether `item` is the Update Zenium row (TB-12): structure, like the Change Menu row. */
export function isUpdateMenuItem(item: MenuItemDescriptor): boolean {
  return item.key === MENU_KEY_UPDATE
}

/** Whether `item` is the Managed Browser row (TB-13): structure, like the Change Menu row. */
export function isManagedMenuItem(item: MenuItemDescriptor): boolean {
  return item.key === MENU_KEY_MANAGED
}

/**
 * `items` less the row `is` names at its tail and the unkeyed hairline before it, the two as a
 * tail section; `items` whole, and an empty section, when the tail is another row's.
 */
function splitTailRow(
  items: readonly MenuItemDescriptor[],
  is: (item: MenuItemDescriptor) => boolean
): { body: MenuItemDescriptor[]; tail: MenuItemDescriptor[] } {
  const last = items[items.length - 1]
  if (!last || !is(last)) return { body: [...items], tail: [] }
  const before = items[items.length - 2]
  const cut = before && before.type === 'separator' && before.key === undefined ? 2 : 1
  return { body: items.slice(0, items.length - cut), tail: items.slice(items.length - cut) }
}

/**
 * `items` less the update row at its head and the unkeyed hairline under it, the two as the
 * `update` section; the list as it is when no update row leads it.
 */
function splitUpdateRow(
  items: readonly MenuItemDescriptor[]
): Pick<MenuSections, 'update' | 'list'> {
  const first = items[0]
  if (!first || !isUpdateMenuItem(first)) return { update: [], list: [...items] }
  const second = items[1]
  const cut = second && second.type === 'separator' && second.key === undefined ? 2 : 1
  return { update: items.slice(0, cut), list: items.slice(cut) }
}

/** Whether a menu's root has an edit mode to offer: the Change Menu row is there to open it. */
export function editableMenu(items: readonly MenuItemDescriptor[]): boolean {
  return items.some(isChangeMenuItem)
}

/** The root's items cut into the sections above (`joinMenuSections` puts them back). */
export function splitMenuSections(items: readonly MenuItemDescriptor[]): MenuSections {
  // The tail is cut from the end inwards: the Managed Browser row stands last of all, the
  // Change Menu row before it.
  const managedCut = splitTailRow(items, isManagedMenuItem)
  const changeCut = splitTailRow(managedCut.body, isChangeMenuItem)
  const tails = { change: changeCut.tail, managed: managedCut.tail }
  const body = changeCut.body
  let firstSep = body.findIndex((item) => item.type === 'separator')
  if (firstSep < 0) firstSep = body.length
  const head = body.slice(0, firstSep)
  if (!isIconRow(head)) return { row: [], rowEnd: null, ...splitUpdateRow(body), ...tails }
  const rowEnd = body[firstSep]
  return {
    row: head,
    rowEnd: rowEnd && rowEnd.key === undefined ? rowEnd : null,
    ...splitUpdateRow(body.slice(rowEnd && rowEnd.key === undefined ? firstSep + 1 : firstSep)),
    ...tails
  }
}

/** The sections as one root again, in the order the sheet draws. */
export function joinMenuSections(sections: MenuSections): MenuItemDescriptor[] {
  return [
    ...sections.row,
    ...(sections.rowEnd ? [sections.rowEnd] : []),
    ...sections.update,
    ...sections.list,
    ...sections.change,
    ...sections.managed
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

/** One of the edit mode's accessibility actions: a slot up, a slot down, or to the section's start. */
export type MenuNudge = -1 | 1 | 'start'

/**
 * `sections` with the item `key` moved by `step` slots within its section (the accessibility
 * actions: Move up is −1, Move down +1), or to the section's start (`step` = `'start'`);
 * unchanged for a key of neither section or a move off either end.
 */
export function nudgeMenuItem(sections: MenuSections, key: string, step: MenuNudge): MenuSections {
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

/**
 * What a nudge says to the reader (the edit pose's live region): the item, and where it went –
 * its new place among its section's rows, or the group it joined when the slot it took was a
 * hairline's and its place among the rows did not change. Empty for a key of neither section.
 */
export function movedSentence(
  before: MenuSections,
  after: MenuSections,
  item: MenuItemDescriptor,
  step: MenuNudge
): string {
  const key = item.key ?? ''
  const section = menuSectionOf(after, key)
  if (!section) return ''
  const was = positionOf(before[section], key)
  const now = positionOf(after[section], key)
  const count = countedItems(after[section]).length
  if (step === 'start') return `${item.label} moved to the start, ${now} of ${count}.`
  if (now === was) {
    return `${item.label} moved to the group ${step < 0 ? 'above' : 'below'}, ${now} of ${count}.`
  }
  return `${item.label} moved to ${now} of ${count}.`
}
