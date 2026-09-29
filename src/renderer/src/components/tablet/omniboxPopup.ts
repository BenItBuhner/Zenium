/**
 * The tablet omnibox popup's height bound (W6-L1): the popup hangs under the toolbar pill and
 * may grow down over the page as far as the VISIBLE viewport lets it – the shell's box less the
 * host's bottom inset, which is the soft keyboard while it is up and the system bar otherwise.
 *
 * `TabletShell` hands the bar the whole window as its box and pads its own bottom by
 * `--zen-inset-bottom` (the inset bridge: `MainActivity.applyInsets` → `applyHostInsets`), so a
 * bound read off the box alone ran the list under the keyboard (the seed of 28 Sep 2026: a
 * twelve-row popup ending at y 659 of 800 against a keyboard edge at 374). Chrome's tablet
 * dropdown is measured `AT_MOST` the window's height less the keyboard's
 * (`OmniboxSuggestionsDropdownEmbedderImpl.recalculateOmniboxAlignment`,
 * `OmniboxSuggestionsContainer.onMeasure`), so its list ends at the keyboard's top edge and
 * scrolls inside; this is Zen's equivalent, with §9.20's 8 px margin against the edge.
 *
 * The inset is taken off in CSS rather than read from `uiStore.insets`: the host streams the
 * keyboard's animation to the root variable frame by frame while the chrome has focus, and a
 * `calc()` lets the popup's bottom ride the keyboard's edge in the compositor without a React
 * render per frame (the phone sheet's paddings in `Urlbar.tsx` take the inset the same way).
 * On the desktop the variable is `0px` (`main.css`'s `:root` default; Electron sends no insets)
 * and the desktop bar never passes an anchor, so this bound is the tablet's alone.
 */

/**
 * The popup's least height: the field's 62 px row and one suggestion row. Under this much room
 * – a very short window with the keyboard up – the popup keeps this height and its tail runs
 * under the keyboard rather than the list vanishing; the desktop's floating bar keeps the same
 * floor.
 */
export const OMNIBOX_POPUP_MIN_HEIGHT = 120

/** The gutter kept between the popup's bottom edge and the visible viewport's (v2 §9.20). */
export const OMNIBOX_POPUP_MARGIN = 8

/**
 * The `max-height` of the tablet popup whose top edge is at `top` in a box `boxHeight` tall: the
 * room down to the box's bottom less the margin, less the host's bottom inset as CSS resolves it
 * (`--zen-inset-bottom`, `0px` on the desktop and while the keyboard is down on a tablet without
 * a bar inset), never under `OMNIBOX_POPUP_MIN_HEIGHT`.
 */
export function omniboxPopupMaxHeight(boxHeight: number, top: number): string {
  const room = boxHeight - top - OMNIBOX_POPUP_MARGIN
  return `max(${OMNIBOX_POPUP_MIN_HEIGHT}px, calc(${room}px - var(--zen-inset-bottom)))`
}

/**
 * What CSS makes of `omniboxPopupMaxHeight`'s expression for a bottom inset of `insetBottom`
 * px: the number the popup is bounded to. The tests read it; the driver on the emulator measures
 * the real box against the same arithmetic.
 */
export function omniboxPopupBound(boxHeight: number, top: number, insetBottom: number): number {
  return Math.max(OMNIBOX_POPUP_MIN_HEIGHT, boxHeight - top - OMNIBOX_POPUP_MARGIN - insetBottom)
}
