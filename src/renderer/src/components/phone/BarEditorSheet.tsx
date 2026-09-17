import type { JSX, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { GripVertical, Minus, Plus, RotateCcw, Search } from 'lucide-react'
import type { PhoneBarItemId, PhoneBarLayout, UIState } from '@shared/types'
import {
  addPhoneBarItem,
  defaultPhoneBar,
  isDefaultPhoneBar,
  phoneBarAvailable,
  phoneBarCapacity,
  phoneBarCount,
  phoneBarForHost,
  phoneBarHas,
  phoneBarLayoutsEqual,
  phoneBarOffered,
  phoneBarSequence,
  PILL,
  removePhoneBarItem,
  slotAtSequencePosition
} from '@shared/phoneBar'
import { cmd, run } from '@renderer/lib/api'
import { useBackSurface } from '@renderer/lib/back'
import { useViewport } from '@renderer/lib/formFactor'
import { SPRING_SNAPPY, SpringAnimation } from '@renderer/lib/motion/spring'
import { browserStore, closeBarEditor, uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'
import { BarPreview } from './BarPreview'
import { barContext, barItem, type BarItemContext } from './barItems'

/** Height of a row in either list: what one step of a drag is worth. */
const ROW = 44
/** How long a finger rests on a row before the row comes off the list. */
const HOLD_MS = 400
/**
 * Movement (px) that ends a hold (the finger is scrolling), or that turns a mouse press into a
 * drag. Matches the sheet's own slop, so a pan the sheet takes never also lifts a row.
 */
const SLOP = 6
/** A finger this close to the list's edge scrolls it while a row is in the hand. */
const EDGE = 32
/** Fastest edge scroll, px per frame. */
const EDGE_SPEED = 12

/** Where a held row would land if released now. */
type DropTarget = { kind: 'bar'; position: number } | { kind: 'available' }

interface Drag {
  id: PhoneBarItemId
  from: 'bar' | 'available'
  /** The layout at lift: what the lists are rendered from until the drop. */
  base: PhoneBarLayout
  /**
   * Layout tops (px, list content coordinates) of the body, the bar list and the Available
   * list – the latter as it is once the hole the held row left has closed.
   */
  bodyTop: number
  barTop: number
  availTop: number
  /** The held row's layout top and the finger's offset within it. */
  rowTop: number
  grab: number
  /** The finger's last position (client px) and whether it has travelled since the lift. */
  pointerY: number
  moved: boolean
  target: DropTarget
  /** `base` with the row where it would land. */
  draft: PhoneBarLayout
}

/** The editor floats above whichever shell is up; it is only ever opened from the phone layout. */
export function BarEditorLayer(): JSX.Element | null {
  const open = uiStore.use((s) => s.barEditorOpen)
  const state = browserStore.use((s) => s.state)
  if (!open || !state) return null
  return <BarEditorSheet state={state} />
}

/**
 * The sheet that rearranges the phone bar (Settings › Navigation bar, or a hold on the bar):
 * the bar itself as a live preview, then the controls in it – in order, with the address pill
 * among them so a control can be dropped on either side – and the controls it could hold.
 * Rows are picked up with their handle, or by holding them, and dragged: the hole they leave
 * closes on the snappy spring, a caret between the rows marks where they will land, and on
 * release every row springs to its new place. A tap on a row's trailing control adds or
 * removes it, and every change is saved at once (the bar behind updates with the rest of the
 * settings), so the sheet needs no Done.
 */
function BarEditorSheet({ state }: { state: UIState }): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const viewport = useViewport()
  const insets = uiStore.use((s) => s.insets)
  const capacity = phoneBarCapacity(viewport.width - insets.left - insets.right)

  // The layout being edited lives here first, so an edit shows before the settings round trip;
  // what the settings say is adopted whenever nothing of ours is still on its way. Both are the
  // layout as this host offers it: an item it cannot run is neither listed nor kept.
  const { capabilities } = state
  const saved = state.settings.phoneBar
  const catalogue = useMemo(() => phoneBarOffered(capabilities), [capabilities])
  const persisted = useMemo(() => phoneBarForHost(saved, catalogue), [saved, catalogue])
  const [layout, setLayout] = useState(persisted)
  const latest = useRef(layout)
  useLayoutEffect(() => {
    latest.current = layout
  })
  const pending = useRef(0)
  useEffect(() => {
    if (pending.current === 0 && !phoneBarLayoutsEqual(latest.current, persisted)) {
      setLayout(persisted)
    }
  }, [persisted])

  const apply = (next: PhoneBarLayout): void => {
    if (phoneBarLayoutsEqual(next, latest.current)) return
    latest.current = next
    setLayout(next)
    pending.current += 1
    void cmd('settings.update', { phoneBar: next })
      .catch(() => undefined)
      .finally(() => {
        pending.current -= 1
      })
  }

  // --- Rows and their motion --------------------------------------------------------------

  const body = useRef<HTMLDivElement>(null)
  const barList = useRef<HTMLUListElement>(null)
  const availList = useRef<HTMLUListElement>(null)
  /** Every element that steps aside: the rows by item id, the pill row, the Available heading. */
  const nodes = useRef(new Map<string, HTMLElement>())
  /** Each element's current translateY. */
  const offsets = useRef(new Map<string, number>())
  const springs = useRef(new Map<string, SpringAnimation>())
  /** Visual tops recorded just before a layout change, for the rows to spring from after it. */
  const flip = useRef<Map<string, number> | null>(null)
  const drag = useRef<Drag | null>(null)
  const [held, setHeld] = useState<Drag | null>(null)
  const swallowClick = useRef(false)
  const autoScroll = useRef<number | null>(null)

  const scroller = (): HTMLElement | null =>
    body.current?.closest<HTMLElement>('.zen-sheet-scroll') ?? null
  /** An element's top in the scroller's content coordinates, as drawn (transform included). */
  const visualTop = (el: Element): number => {
    const sc = scroller()
    if (!sc) return 0
    return el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop
  }
  const layoutTop = (el: Element, key: string): number =>
    visualTop(el) - (offsets.current.get(key) ?? 0)

  const paint = (key: string, y: number): void => {
    offsets.current.set(key, y)
    const el = nodes.current.get(key)
    if (el) el.style.transform = y ? `translateY(${y.toFixed(2)}px)` : ''
  }
  const springFor = (key: string): SpringAnimation => {
    let spring = springs.current.get(key)
    if (!spring) {
      spring = new SpringAnimation(
        SPRING_SNAPPY,
        (y) => paint(key, y),
        (y) => paint(key, y)
      )
      springs.current.set(key, spring)
    }
    return spring
  }
  /** Take the element called `key` to `target` on the spring, from wherever it is. */
  const settle = (key: string, target: number): void => {
    const spring = springFor(key)
    const current = offsets.current.get(key) ?? 0
    if (spring.running) spring.retarget(target)
    else if (Math.abs(current - target) > 0.01) spring.start(current, 0, target)
  }
  useEffect(
    () => () => {
      for (const spring of springs.current.values()) spring.stop()
      if (autoScroll.current !== null) cancelAnimationFrame(autoScroll.current)
    },
    []
  )

  /** Change the layout, with every row springing from where it was drawn to where it is now. */
  const edit = (next: PhoneBarLayout): void => {
    if (phoneBarLayoutsEqual(next, latest.current)) return
    const tops = new Map<string, number>()
    for (const [key, el] of nodes.current) tops.set(key, visualTop(el))
    flip.current = tops
    apply(next)
  }

  // After a layout change the rows are in their new places: each one springs the last stretch.
  useLayoutEffect(() => {
    const tops = flip.current
    if (!tops) return
    flip.current = null
    for (const spring of springs.current.values()) spring.stop()
    for (const [key, el] of nodes.current) {
      el.style.transform = ''
      offsets.current.set(key, 0)
    }
    for (const [key, el] of nodes.current) {
      const was = tops.get(key)
      if (was === undefined) continue
      const delta = was - visualTop(el)
      if (Math.abs(delta) < 0.5) continue
      paint(key, delta)
      springFor(key).start(delta, 0, 0)
    }
  })

  // --- Dragging ---------------------------------------------------------------------------

  const lift = (
    id: PhoneBarItemId,
    from: 'bar' | 'available',
    el: HTMLElement,
    pointerId: number,
    clientY: number
  ): boolean => {
    const sc = scroller()
    if (!sc || !body.current || !barList.current || !availList.current || drag.current) return false
    const base = latest.current
    const rowTop = layoutTop(el, id)
    const contentY = clientY - sc.getBoundingClientRect().top + sc.scrollTop
    const position =
      from === 'bar' ? phoneBarSequence(base).indexOf(id) : phoneBarSequence(base).length
    const d: Drag = {
      id,
      from,
      base,
      bodyTop: visualTop(body.current),
      barTop: visualTop(barList.current),
      availTop: visualTop(availList.current) - (from === 'bar' ? ROW : 0),
      rowTop,
      grab: contentY - rowTop,
      pointerY: clientY,
      moved: false,
      target: from === 'bar' ? { kind: 'bar', position } : { kind: 'available' },
      draft: base
    }
    drag.current = d
    setHeld(d)
    swallowClick.current = true
    try {
      el.setPointerCapture(pointerId)
    } catch {
      /* the pointer is gone */
    }
    run('haptic', { kind: 'lift' })
    closeHole(d)
    autoScroll.current = requestAnimationFrame(scrollTick)
    return true
  }

  /** The finger moved (or the list scrolled under it): move the row and re-aim the caret. */
  const track = (): void => {
    const d = drag.current
    const sc = scroller()
    if (!d || !sc) return
    const contentY = d.pointerY - sc.getBoundingClientRect().top + sc.scrollTop
    const top = contentY - d.grab
    paint(d.id, top - d.rowTop)
    if (!d.moved) return

    const without = d.from === 'bar' ? removePhoneBarItem(d.base, d.id) : d.base
    const rows = phoneBarSequence(without).length
    let target: DropTarget
    if (top < d.barTop + (rows + 0.5) * ROW) {
      const position = Math.max(0, Math.min(rows, Math.round((top - d.barTop) / ROW)))
      target = { kind: 'bar', position }
    } else {
      target = { kind: 'available' }
    }
    let draft =
      target.kind === 'bar'
        ? addPhoneBarItem(without, d.id, slotAtSequencePosition(without, target.position), capacity)
        : without
    // A full bar does not open a slot for a control it cannot take.
    if (target.kind === 'bar' && !phoneBarHas(draft, d.id)) {
      target = { kind: 'available' }
      draft = without
    }
    if (sameTarget(target, d.target)) return
    d.target = target
    d.draft = draft
    setHeld({ ...d })
    settle('caret', caretY(d))
  }

  /**
   * The hole a lifted row leaves closes at once: every row after it in its list – and, when it
   * came out of the bar, the Available heading and list too – moves up one row on the spring.
   */
  const closeHole = (d: Drag): void => {
    const seq = phoneBarSequence(d.base)
    const avail = phoneBarAvailable(d.base, catalogue)
    if (d.from === 'bar') {
      const at = seq.indexOf(d.id)
      seq.forEach((key, i) => {
        if (key !== d.id) settle(key, i > at ? -ROW : 0)
      })
      settle('head', -ROW)
      for (const key of avail) settle(key, -ROW)
    } else {
      const at = avail.indexOf(d.id)
      avail.forEach((key, i) => {
        if (key !== d.id) settle(key, i > at ? -ROW : 0)
      })
    }
    paint('caret', caretY(d))
  }

  /**
   * Where the caret sits (px from the body's top) for the drop `d` is aiming at: the gap
   * before the row the held one would become, in either list as it is with the hole closed.
   */
  const caretY = (d: Drag): number => {
    let y: number
    if (d.target.kind === 'bar') {
      y = d.barTop + d.target.position * ROW
    } else {
      const avail = phoneBarAvailable(d.draft, catalogue)
      const at = avail.indexOf(d.id)
      y = d.availTop + (at < 0 ? avail.length : at) * ROW
    }
    return y - d.bodyTop
  }

  const scrollTick = (): void => {
    autoScroll.current = null
    const d = drag.current
    const sc = scroller()
    if (!d || !sc) return
    if (d.moved) {
      const r = sc.getBoundingClientRect()
      let dy = 0
      if (d.pointerY < r.top + EDGE)
        dy = -EDGE_SPEED * Math.min(1, (r.top + EDGE - d.pointerY) / EDGE)
      else if (d.pointerY > r.bottom - EDGE)
        dy = EDGE_SPEED * Math.min(1, (d.pointerY - (r.bottom - EDGE)) / EDGE)
      if (dy) {
        const before = sc.scrollTop
        sc.scrollTop = before + dy
        if (sc.scrollTop !== before) track()
      }
    }
    autoScroll.current = requestAnimationFrame(scrollTick)
  }

  const drop = (cancelled: boolean): void => {
    const d = drag.current
    if (!d) return
    drag.current = null
    if (autoScroll.current !== null) cancelAnimationFrame(autoScroll.current)
    autoScroll.current = null
    const next = cancelled ? d.base : d.draft
    // The lists re-render from `next`; every row, the held one included, springs from where it
    // is drawn now to its new place.
    const tops = new Map<string, number>()
    for (const [key, el] of nodes.current) tops.set(key, visualTop(el))
    flip.current = tops
    apply(next)
    setHeld(null)
  }

  /**
   * Pointer down on a row. The handle lifts the row at once; elsewhere a finger lifts it after
   * a hold (moving first means it is scrolling, or dragging the sheet) and a mouse by dragging.
   * Once lifted the row's moves are its own – the sheet never sees them – until the release.
   */
  const press = (
    e: ReactPointerEvent<HTMLElement>,
    id: PhoneBarItemId,
    from: 'bar' | 'available'
  ): void => {
    swallowClick.current = false
    if (e.button !== 0 || drag.current) return
    const target = e.target as HTMLElement
    const onHandle = target.closest('[data-bar-handle]') !== null
    // A press on the row's own button is a tap on it, not the start of a drag.
    if (!onHandle && target.closest('button')) return
    const el = e.currentTarget
    const pointerId = e.pointerId
    const x0 = e.clientX
    const y0 = e.clientY
    const mouse = e.pointerType === 'mouse'
    let lifted = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const cleanup = (): void => {
      if (timer) clearTimeout(timer)
      timer = null
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onCancel)
      el.removeEventListener('touchmove', blockTouchScroll)
    }
    const begin = (): void => {
      if (timer) clearTimeout(timer)
      timer = null
      // The sheet took the touch (it was caught mid-flight): the row stays put.
      if (el.closest('.zen-sheet')?.getAttribute('data-dragging') === 'true') return cleanup()
      lifted = lift(id, from, el, pointerId, y0)
      if (!lifted) return cleanup()
      el.addEventListener('touchmove', blockTouchScroll, { passive: false })
    }
    const onMove = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return
      const far = Math.hypot(ev.clientX - x0, ev.clientY - y0) >= SLOP
      if (!lifted) {
        if (!far) return
        if (mouse) begin()
        else cleanup()
        return
      }
      // Ours: the sheet's own drag handling must not see this move.
      ev.stopPropagation()
      const d = drag.current
      if (!d) return
      d.pointerY = ev.clientY
      if (far) d.moved = true
      track()
    }
    const onUp = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return
      cleanup()
      if (lifted) drop(false)
    }
    const onCancel = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return
      cleanup()
      if (lifted) drop(true)
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onCancel)
    if (onHandle) begin()
    else if (!mouse) timer = setTimeout(begin, HOLD_MS)
  }

  // --- Sheet ------------------------------------------------------------------------------

  useBackSurface({
    name: 'bar-editor',
    onProgress: (progress) => sheet.current?.backProgress(progress),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      sheet.current?.dismiss()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  // The header gets its hairline once the rows have scrolled under it, and loses it at the top.
  useEffect(() => {
    const sc = scroller()
    const sheetEl = sc?.closest<HTMLElement>('.zen-sheet')
    if (!sc || !sheetEl) return
    const sync = (): void => {
      sheetEl.dataset.scrolled = String(sc.scrollTop > 0)
    }
    sync()
    sc.addEventListener('scroll', sync, { passive: true })
    return () => sc.removeEventListener('scroll', sync)
  }, [])

  const ctx = barContext(state, false)
  const shown = held?.draft ?? layout
  const full = phoneBarCount(layout) >= capacity
  const room = Math.max(0, capacity - phoneBarCount(layout))
  const sequence = phoneBarSequence(layout)
  const available = phoneBarAvailable(layout, catalogue)
  const add = (id: PhoneBarItemId): void => {
    if (full) {
      run('haptic', { kind: 'tick' })
      return
    }
    edit(addPhoneBarItem(layout, id, { side: 'right', index: Infinity }, capacity))
  }

  return (
    <BottomSheet
      ref={sheet}
      onDismissed={() => closeBarEditor()}
      handleLabel="Resize editor"
      className="zen-bar-editor"
      header={
        <div className="flex h-9 items-center gap-1 pl-3">
          <h2 className="zen-bar-title min-w-0 flex-1 truncate">Navigation Bar</h2>
          <button
            type="button"
            className="zen-toolbar-button h-11 w-11 shrink-0"
            aria-label="Reset to defaults"
            disabled={isDefaultPhoneBar(layout)}
            onClick={() => edit(defaultPhoneBar())}
          >
            <RotateCcw className="h-5 w-5" strokeWidth={1.75} />
          </button>
        </div>
      }
    >
      <div
        ref={body}
        className="relative flex flex-col pb-1 pt-1"
        onClickCapture={(e) => {
          if (!swallowClick.current) return
          swallowClick.current = false
          e.preventDefault()
          e.stopPropagation()
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <BarPreview layout={shown} ctx={ctx} className="-mx-3 mb-2" />
        {held && (
          <div
            ref={(el) => {
              if (el) {
                nodes.current.set('caret', el)
                // Aimed at lift, before it was mounted: take up the position it was given.
                paint('caret', offsets.current.get('caret') ?? 0)
              } else nodes.current.delete('caret')
            }}
            className="zen-bar-caret"
            aria-hidden
          />
        )}
        <h3 className="zen-bar-heading">In the bar</h3>
        <ul ref={barList} className="flex flex-col" aria-label="In the bar">
          {sequence.map((entry) =>
            entry === PILL ? (
              <li
                key={PILL}
                ref={(el) => {
                  if (el) nodes.current.set(PILL, el)
                  else nodes.current.delete(PILL)
                }}
                className="zen-bar-row"
                aria-label="Address bar"
              >
                <span className="h-8 w-8 shrink-0" />
                <span className="flex h-8 w-8 shrink-0 items-center justify-center">
                  <Search className="h-5 w-5" strokeWidth={1.75} />
                </span>
                <span className="min-w-0 flex-1 truncate">Address bar</span>
                <span className="zen-bar-note shrink-0 pr-3">Always shown</span>
              </li>
            ) : (
              <ItemRow
                key={entry}
                id={entry}
                ctx={ctx}
                held={held?.id === entry}
                ref={(el) => {
                  if (el) nodes.current.set(entry, el)
                  else nodes.current.delete(entry)
                }}
                onPointerDown={(e) => press(e, entry, 'bar')}
                handle
                control={
                  <button
                    type="button"
                    className="zen-toolbar-button zen-row-action h-11 w-11 shrink-0"
                    aria-label={`Remove ${barItem(entry).label}`}
                    onClick={() => edit(removePhoneBarItem(layout, entry))}
                  >
                    <Minus className="h-5 w-5" strokeWidth={1.75} />
                  </button>
                }
              />
            )
          )}
        </ul>
        <div
          ref={(el) => {
            if (el) nodes.current.set('head', el)
            else nodes.current.delete('head')
          }}
          className="pt-4"
        >
          <h3 className="zen-bar-heading">Available</h3>
          <p className="zen-bar-caption" aria-live="polite">
            {full
              ? 'The bar is full: remove a control to make room for another.'
              : `Room for ${room} more beside the address bar.`}
          </p>
        </div>
        <ul ref={availList} className="flex flex-col" aria-label="Available">
          {available.map((id) => (
            <ItemRow
              key={id}
              id={id}
              ctx={ctx}
              held={held?.id === id}
              ref={(el) => {
                if (el) nodes.current.set(id, el)
                else nodes.current.delete(id)
              }}
              onPointerDown={(e) => press(e, id, 'available')}
              onClick={() => add(id)}
              control={
                <button
                  type="button"
                  className="zen-toolbar-button zen-row-action h-11 w-11 shrink-0"
                  aria-label={`Add ${barItem(id).label}`}
                  aria-disabled={full || undefined}
                  data-disabled={full || undefined}
                >
                  <Plus className="h-5 w-5" strokeWidth={1.75} />
                </button>
              }
            />
          ))}
        </ul>
      </div>
    </BottomSheet>
  )
}

function sameTarget(a: DropTarget, b: DropTarget): boolean {
  return a.kind === b.kind && (a.kind !== 'bar' || b.kind !== 'bar' || a.position === b.position)
}

/** A touch that has picked a row up must not scroll the list; touch-action is too late for that. */
function blockTouchScroll(e: TouchEvent): void {
  if (e.cancelable) e.preventDefault()
}

/** A control as a row: its glyph as drawn in the bar, its name, and the add or remove button. */
function ItemRow({
  id,
  ctx,
  held,
  handle,
  control,
  ref,
  onPointerDown,
  onClick
}: {
  id: PhoneBarItemId
  ctx: BarItemContext
  held: boolean
  /** Leading drag handle (rows in the bar). */
  handle?: boolean
  control: ReactNode
  ref: (el: HTMLLIElement | null) => void
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
  onClick?: () => void
}): JSX.Element {
  const item = barItem(id)
  return (
    <li
      ref={ref}
      className={cn('zen-bar-row', onClick && 'zen-bar-row-pressable')}
      data-held={held || undefined}
      onPointerDown={onPointerDown}
      onClick={onClick}
    >
      {handle ? (
        <span
          data-bar-handle
          className="zen-bar-handle flex h-8 w-8 shrink-0 items-center justify-center"
          aria-hidden
        >
          <GripVertical className="h-5 w-5" strokeWidth={1.75} />
        </span>
      ) : (
        // Keeps the glyphs of both lists in one column; a hold still picks the row up.
        <span className="h-8 w-8 shrink-0" />
      )}
      <span className="flex h-8 w-8 shrink-0 items-center justify-center">{item.glyph(ctx)}</span>
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {control}
    </li>
  )
}
