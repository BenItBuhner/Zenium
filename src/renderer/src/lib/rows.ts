/**
 * Row sizing from the design language (docs/design-language-v2-draft.md §9.2, §9.21): a row's
 * minimum height is its base, 32 on a desktop and 44 on a phone, and a row that holds a control
 * grows around it – the larger of the base and the control's height plus 8, the 4 above and
 * below being the row's own padding rather than a list gap, so rows still touch.
 */

/** Minimum height of a one-line row without a control (§9.2). */
export function rowBase(phone: boolean): number {
  return phone ? 44 : 32
}

/** Padding above and below a row's control, whatever the row's height (§9.21). */
export const ROW_CONTROL_PADDING = 4

/** Minimum height of a row holding a control `control` px tall (§9.21). */
export function rowMinHeight(control: number, phone: boolean): number {
  return Math.max(rowBase(phone), control + ROW_CONTROL_PADDING * 2)
}
