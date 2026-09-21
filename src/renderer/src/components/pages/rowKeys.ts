import type { KeyboardEvent } from 'react'

/*
 * The keyboard reach of a list page's rows (design language v2 §9.22), shared by History and
 * Downloads: the arrows walk the rows' focus targets across every group, Home and End jump to
 * the first and last; a key from inside a text field – the page's search field – is the field's.
 */

/** Whether a key came from a text field (the search field), whose keys are its own. */
export function inTextField(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement && target.type !== 'checkbox'
}

/**
 * The arrows walk the rows' focus targets (`data-row-focus`: a row's primary button, or the row
 * itself) across every group, Home and End jump to the first and last (§9.22); a key from inside
 * the search field is the field's.
 */
export function walkRows(
  e: KeyboardEvent<HTMLElement>,
  list: { current: HTMLElement | null }
): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
  const target = e.target
  if (!(target instanceof HTMLElement) || inTextField(target)) return
  const rows = [...(list.current?.querySelectorAll<HTMLElement>('[data-row-focus]') ?? [])]
  if (rows.length === 0) return
  const row = target.closest<HTMLElement>('.zen-v2-row')
  const at = rows.findIndex((r) => r === target || (row !== null && row.contains(r)))
  let next: number
  if (e.key === 'Home') next = 0
  else if (e.key === 'End') next = rows.length - 1
  else if (at === -1) next = e.key === 'ArrowDown' ? 0 : rows.length - 1
  else next = Math.min(rows.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)))
  e.preventDefault()
  rows[next]?.focus()
}
