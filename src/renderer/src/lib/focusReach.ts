/**
 * Keyboard reach into popovers and dialogs (design language v2 §9.22): what Tab visits inside a
 * container, where focus goes when the container opens, and how Tab wraps at its ends. Pure DOM
 * helpers; `useFocusReach` wires them to a component.
 */

const TABBABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(', ')

function isRadio(el: Element): el is HTMLInputElement {
  return el instanceof HTMLInputElement && el.type === 'radio'
}

/**
 * The elements Tab visits inside `root`, in document order: enabled, not hidden, not `tabindex
 * -1`. A group of radio buttons counts once, as the browser tabs it: its checked button, or the
 * first when none is checked.
 */
export function tabbablesIn(root: HTMLElement): HTMLElement[] {
  const all = [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (el) => !el.hidden && !el.closest('[hidden]') && el.getClientRects().length > 0
  )
  return all.filter((el) => {
    if (!isRadio(el) || !el.name) return true
    const group = all.filter((o): o is HTMLInputElement => isRadio(o) && o.name === el.name)
    const checked = group.find((o) => o.checked)
    return el === (checked ?? group[0])
  })
}

/**
 * Where focus goes when `root` opens: its first tabbable element (a form's first field, a
 * panel's first row or button), or `root` itself when nothing inside is tabbable (a title and
 * a notice), which then needs `tabIndex -1` to take it.
 */
export function initialFocusIn(root: HTMLElement): HTMLElement {
  return tabbablesIn(root)[0] ?? root
}

/**
 * The element a Tab press inside `root` should land on when it would otherwise leave it: from the
 * last tabbable (or the container itself) forward to the first, from the first backward to the
 * last. Null when the browser's own move stays inside and nothing needs doing.
 */
export function wrapTabTarget(
  root: HTMLElement,
  active: Element | null,
  backward: boolean
): HTMLElement | null {
  const tabbables = tabbablesIn(root)
  const first = tabbables[0]
  const last = tabbables[tabbables.length - 1]
  if (!first || !last) return root
  if (active === root) return backward ? last : first
  const inRadioGroupOf = (edge: HTMLElement): boolean =>
    isRadio(edge) &&
    active instanceof HTMLInputElement &&
    isRadio(active) &&
    active.name === edge.name
  if (!backward && (active === last || inRadioGroupOf(last))) return first
  if (backward && (active === first || inRadioGroupOf(first))) return last
  return null
}
