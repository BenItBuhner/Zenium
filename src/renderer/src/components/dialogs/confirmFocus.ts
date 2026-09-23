/*
 * The keyboard machinery of the §9.23 confirmation, shared by its hosts (the #392 and #401
 * rulings, one implementation): the frame's `ConfirmDialog`, a prompt over the page, and a
 * confirmation that is a LEVEL of a surface with levels – §10.4's site-information Clear cookies
 * and Clear site data, a pane of the phone sheet (`siteinfo/SiteInfoSheet.tsx`). The contract is
 * the same in either place (§9.22 as amended): the container holds the focus on entry and draws
 * no ring; Enter from it is the primary's on a plain prompt and inert on a destructive one; Tab
 * enters at Cancel, then the verb (`lib/popover.ts` `wrapTab`); and as the prompt leaves the
 * keyboard goes back one hop to where it came from, unless something else has taken it.
 */
import { HELD, returnFocusTo } from '@renderer/lib/popover'

/**
 * Where the keyboard goes as a prompt leaves (§9.5, §9.22): the control that had it as the
 * prompt opened (the default, `undefined`), an element or a function read at the leave (a
 * consumer that decides by the answer – a keyboard's Cancel to the row it came from, a Delete
 * whose row goes with it to nothing), or `false` for no return of the prompt's own (a consumer
 * that hands the keyboard to the page itself).
 */
export type ConfirmReturnFocus = HTMLElement | (() => HTMLElement | null | undefined) | false

/** The control an Enter belongs to rather than to the prompt: a button answers its own Enter. */
export const OWN_ENTER = 'button, a[href], [role="button"], select, textarea'

/**
 * Enter on the prompt's container, or on a control of the prompt with no Enter of its own (a
 * check row): on a prompt whose verb is the primary it is the default button's – `confirm()`,
 * as Firefox's and Chrome's dialogs answer Enter from the dialog itself. On a DESTRUCTIVE
 * prompt there is no default (§6 draws no primary, and a default key is a recommendation as
 * much as a fill): the key is the prompt's to swallow – consumed, reaching nothing beneath, and
 * confirming nothing. Enter on a button, a link, a select or a textarea is that control's own
 * and is left alone; so is Enter with a modifier, a key repeat, or one ending a composition.
 * True when the key was the prompt's – the host stops its own propagation then.
 */
export function answerEnter(e: KeyboardEvent, destructive: boolean, confirm: () => void): boolean {
  if (e.key !== 'Enter' || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false
  if (e.repeat || e.isComposing) return false
  if (e.target instanceof Element && e.target.closest(OWN_ENTER)) return false
  e.preventDefault()
  e.stopPropagation()
  if (!destructive) confirm()
  return true
}

/**
 * The container takes the focus as the prompt comes (§9.22): `root` is `tabIndex -1`, the
 * element the keyboard is sent to and cannot reach by Tab, so the chassis draws no ring on it
 * and no verb is preselected. A host whose level is not a prompt – a detail level of the same
 * sheet, which lands on its first row as the desktop's levels and a sheet's opening focus do –
 * names where the keyboard goes as `at`. Returns the opener – whatever held the focus as the
 * prompt came: a control of the chrome, a row of a page, a lower dialog's control, the row of a
 * lower level – and not `body`, for `releaseFocus` as the prompt leaves.
 */
export function holdFocus(root: HTMLElement, at: HTMLElement = root): HTMLElement | null {
  const active = document.activeElement
  const opener =
    active instanceof HTMLElement && active !== document.body && !root.contains(active)
      ? active
      : null
  at.focus({ preventScroll: true })
  return opener
}

/** The element a consumer's `returnFocus` names for the leave: the opener by default. */
export function resolveReturnFocus(
  wanted: ConfirmReturnFocus | undefined,
  opener: HTMLElement | null
): HTMLElement | null {
  if (wanted === false) return null
  if (wanted === undefined) return opener
  return (typeof wanted === 'function' ? wanted() : wanted) ?? null
}

/**
 * The return (§9.5, one hop down): as the prompt in `root` leaves, `target` gets the keyboard
 * back through `returnFocusTo`, which waits for an `inert` to lift and never lets the focus fall
 * to `body`. Only a focus the leave loses is given back: one still on the prompt (kept on its
 * way out), fallen to `body`, parked on a held container (`HELD`: at no control), or under an
 * `inert` or a `[data-leaving]` subtree; one the user or a dialog opened over the way out has
 * already placed is left alone, and a `target` that is gone from the document gets nothing.
 * True when the return was made.
 */
export function releaseFocus(root: HTMLElement, target: HTMLElement | null): boolean {
  if (!target?.isConnected) return false
  const now = document.activeElement
  const lost =
    !now ||
    now === document.body ||
    root.contains(now) ||
    now.matches(HELD) ||
    now.closest('[inert], [data-leaving]') !== null
  if (!lost) return false
  returnFocusTo(target)
  return true
}
