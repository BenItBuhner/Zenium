import type { RefObject } from 'react'
import { useEffect, useLayoutEffect, useRef } from 'react'

/*
 * One popover at a time, by light dismiss that is consumed (design-language-v2-draft §9.20,
 * amended). Every popover in the chrome layer registers here once while it is open, and the
 * registry keeps one set of window listeners for all of them:
 *
 *   - A pointer press outside every open popover – the page, a bar, another anchor, the
 *     anchor itself – closes them on `pointerdown` and goes no further: the press is cancelled
 *     and its follow-up events (`pointerup`, the compatibility mouse events, `click`,
 *     `auxclick`, `contextmenu`) are swallowed, so a second anchor's first press only closes
 *     the open popover and its second press opens the new one, and the open anchor's own press
 *     closes its popover without reopening it. Nothing beneath a popover ever receives the press
 *     that dismissed it.
 *   - A scroll anywhere outside the popovers – a wheel turned over the frame or a bar, a chrome
 *     list scrolling – and a window resize close them. A Ctrl+wheel is a zoom, not a scroll,
 *     and leaves them be.
 *   - Opening a popover closes every other open one, except the popovers it sits in: a popover
 *     whose anchor is inside an open popover (a menulist's list inside the star bubble) is that
 *     popover's child, and a press inside the child keeps the parent open.
 *   - Focus: a press on the anchor puts the focus there (that is where the press went, even
 *     consumed); after any other outside press the focus that was inside a closed popover goes
 *     back to the outermost closed popover's anchor (§9.22) unless the popover's own close
 *     handler moved it.
 *
 * Escape stays with the popover: it traps the key, closes and returns focus to its anchor
 * (§9.22), because a nested level (a submenu, a folder chooser) decides what one Escape means.
 *
 * The listeners sit on `window` in the capture phase, the first place a press can be seen:
 * `#zen-chrome-layer` itself catches no pointer, and a press outside the popovers targets
 * whatever chrome lies under it, never the layer.
 */

/** Why a popover was closed by the registry. */
export type DismissReason =
  /** A pointer press outside it (and not on its anchor). */
  | 'outside'
  /** A pointer press on its own anchor: closed, not reopened. */
  | 'anchor'
  /** Something outside it scrolled, or a wheel turned outside it. */
  | 'scroll'
  /** The window resized. */
  | 'resize'
  /** Another popover opened (one at a time). */
  | 'replaced'
  /** A frame dialog opened over the chrome, or `closeAllPopovers()` was called. */
  | 'all'

type ElementGetter = () => Element | null

export interface PopoverRegistration {
  /** The popover's root: a press inside it, or inside a popover it owns, leaves it open. */
  element: ElementGetter
  /**
   * What opened it. A popover whose anchor sits inside an open popover is that popover's child;
   * a press on the anchor closes the popover with reason `anchor`; and the anchor takes the
   * focus back when an outside press closes a popover that held it.
   */
  anchor?: ElementGetter
  close: (reason: DismissReason) => void
}

interface Entry extends PopoverRegistration {
  id: number
  parent: Entry | null
}

let seq = 0
/** The open popovers in the order they opened: the last one is on top. */
const entries: Entry[] = []

const contains = (entry: Entry, node: Node): boolean => entry.element()?.contains(node) ?? false
const anchorContains = (entry: Entry, node: Node): boolean =>
  entry.anchor?.()?.contains(node) ?? false

/** The popovers `entry` sits in, nearest first. */
function ancestorsOf(entry: Entry): Entry[] {
  const list: Entry[] = []
  for (let p = entry.parent; p; p = p.parent) list.push(p)
  return list
}

/** Take `list` out of the registry, then close each, the one on top first. */
function closeEntries(
  list: Entry[],
  reason: DismissReason | ((entry: Entry) => DismissReason)
): void {
  if (!list.length) return
  for (const entry of list) {
    const at = entries.indexOf(entry)
    if (at !== -1) entries.splice(at, 1)
  }
  for (const entry of entries) {
    while (entry.parent && list.includes(entry.parent)) entry.parent = entry.parent.parent
  }
  syncListeners()
  for (let i = list.length - 1; i >= 0; i--) {
    const entry = list[i]
    entry.close(typeof reason === 'function' ? reason(entry) : reason)
  }
}

/**
 * Register an open popover. Every other open popover closes, except the ones the new popover
 * sits in. Returns the function that takes it out of the registry again (the popover closing
 * by itself: Escape, a row chosen, its anchor toggled).
 */
export function openPopover(registration: PopoverRegistration): () => void {
  const anchorEl = registration.anchor?.() ?? null
  let parent: Entry | null = null
  if (anchorEl) {
    for (let i = entries.length - 1; i >= 0; i--) {
      if (contains(entries[i], anchorEl)) {
        parent = entries[i]
        break
      }
    }
  }
  const entry: Entry = { ...registration, id: ++seq, parent }
  const keep = new Set(ancestorsOf(entry))
  closeEntries(
    entries.filter((e) => !keep.has(e)),
    'replaced'
  )
  entries.push(entry)
  syncListeners()
  return () => {
    const at = entries.indexOf(entry)
    if (at === -1) return
    entries.splice(at, 1)
    for (const e of entries) if (e.parent === entry) e.parent = entry.parent
    syncListeners()
  }
}

/** Close every open popover: a frame dialog opening, a command that wants the chrome clear. */
export function closeAllPopovers(reason: DismissReason = 'all'): void {
  closeEntries([...entries], reason)
}

/** How many popovers are open (registered). */
export function openPopoverCount(): number {
  return entries.length
}

// ---------------------------------------------------------------------------
// The window listeners, on while any popover is open or a consumed press is being swallowed
// ---------------------------------------------------------------------------

let installed = false
/** The press that dismissed a popover is being swallowed through to its `click`. */
let swallowing = false
let swallowTimer: ReturnType<typeof setTimeout> | null = null

function endSwallow(): void {
  swallowing = false
  if (swallowTimer !== null) clearTimeout(swallowTimer)
  swallowTimer = null
}

function endSwallowSoon(): void {
  if (swallowTimer !== null) clearTimeout(swallowTimer)
  // The `click` (or `auxclick`, `contextmenu`) of a press is dispatched with its release, before
  // any timer: whatever the release did not produce is not coming.
  swallowTimer = setTimeout(() => {
    endSwallow()
    syncListeners()
  }, 0)
}

function onPointerDown(e: PointerEvent): void {
  // A new press: whatever the last consumed press did not produce is over.
  endSwallow()
  const target = e.target
  if (!(target instanceof Node) || !entries.length) {
    syncListeners()
    return
  }
  const keep = new Set<Entry>()
  for (const entry of entries) {
    if (!contains(entry, target)) continue
    keep.add(entry)
    for (const a of ancestorsOf(entry)) keep.add(a)
  }
  const closing = entries.filter((entry) => !keep.has(entry))
  if (!closing.length) return
  // Where the focus goes: to the anchor that was pressed, or – when the focus was inside a
  // closing popover – back to what opened the outermost closing popover it sits in (a list's
  // trigger inside a bubble goes with the bubble; the star that opened the bubble stays).
  const pressed = closing.find((entry) => anchorContains(entry, target))
  const active = document.activeElement
  let refocus: Element | null = pressed?.anchor?.() ?? null
  if (!refocus && active) {
    let holder = closing.find((entry) => contains(entry, active)) ?? null
    while (holder?.parent && closing.includes(holder.parent)) holder = holder.parent
    refocus = holder?.anchor?.() ?? null
  }
  // Swallowing before the registry empties keeps the listeners on for the rest of this press.
  swallowing = true
  closeEntries(closing, (entry) => (entry === pressed ? 'anchor' : 'outside'))
  // A close handler that moved the focus itself (to another chip, to the page) has the last word.
  const now = document.activeElement
  const unmoved = now === active || !now || now === document.body
  if (unmoved && refocus instanceof HTMLElement) refocus.focus({ preventScroll: true })
  e.preventDefault()
  e.stopPropagation()
}

/** The rest of a consumed press: none of it reaches what lies under the popover it dismissed. */
function onSwallowed(e: Event): void {
  if (!swallowing) return
  e.preventDefault()
  e.stopPropagation()
  if (e.type === 'pointerup' || e.type === 'pointercancel') endSwallowSoon()
}

function onScroll(e: Event): void {
  if (!entries.length) return
  // A wheel turned with Ctrl held is a zoom, not a scroll: the zoom bubble goes on zooming.
  if (e.type === 'wheel' && 'ctrlKey' in e && e.ctrlKey === true) return
  const target = e.target
  if (target instanceof Node && entries.some((entry) => contains(entry, target))) return
  closeAllPopovers('scroll')
}

function onResize(): void {
  if (entries.length) closeAllPopovers('resize')
}

const SWALLOWED = [
  'pointerup',
  'pointercancel',
  'mousedown',
  'mouseup',
  'click',
  'auxclick',
  'contextmenu'
]

/**
 * The listeners are on while a popover is open, and stay on through the swallowed remainder of
 * the press that closed the last one.
 */
function syncListeners(): void {
  const wanted = entries.length > 0 || swallowing
  if (wanted === installed || typeof window === 'undefined') return
  installed = wanted
  if (wanted) {
    window.addEventListener('pointerdown', onPointerDown, true)
    for (const type of SWALLOWED) window.addEventListener(type, onSwallowed, true)
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    window.addEventListener('wheel', onScroll, { capture: true, passive: true })
    window.addEventListener('resize', onResize)
  } else {
    window.removeEventListener('pointerdown', onPointerDown, true)
    for (const type of SWALLOWED) window.removeEventListener(type, onSwallowed, true)
    window.removeEventListener('scroll', onScroll, true)
    window.removeEventListener('wheel', onScroll, true)
    window.removeEventListener('resize', onResize)
  }
}

// ---------------------------------------------------------------------------
// The hook popovers register through
// ---------------------------------------------------------------------------

export interface LightDismissOptions {
  /** What opened the popover (see `PopoverRegistration.anchor`). */
  anchor?: RefObject<Element | null> | ElementGetter
  /** Not open: nothing is registered (a phone sheet in place of the popover, a closed list). */
  disabled?: boolean
}

/**
 * Register the popover at `ref` for the chrome layer's light dismiss while it is mounted (and
 * not `disabled`): `onDismiss` runs when a press outside it, a scroll, a resize, another popover
 * opening or a frame dialog closes it, and the popover then unmounts itself. Registers once per
 * mount; the latest `onDismiss` and `anchor` are used without re-registering.
 */
export function useLightDismiss(
  ref: RefObject<Element | null>,
  onDismiss: (reason: DismissReason) => void,
  options: LightDismissOptions = {}
): void {
  const latest = useRef({ onDismiss, anchor: options.anchor })
  useLayoutEffect(() => {
    latest.current = { onDismiss, anchor: options.anchor }
  })
  const disabled = options.disabled ?? false
  useEffect(() => {
    if (disabled) return
    return openPopover({
      element: () => ref.current,
      anchor: () => {
        const anchor = latest.current.anchor
        return typeof anchor === 'function' ? anchor() : (anchor?.current ?? null)
      },
      close: (reason) => latest.current.onDismiss(reason)
    })
  }, [disabled, ref])
}
