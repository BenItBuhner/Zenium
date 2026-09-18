import type { CSSProperties, JSX, PointerEvent as ReactPointerEvent } from 'react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Palette, Plus } from 'lucide-react'
import type { Space, Tab, UIState } from '@shared/types'
import { resolveTheme, rgbToHex } from '@shared/theme'
import { run } from '@renderer/lib/api'
import {
  beginDrawerDrag,
  closeSpacesDrawer,
  dragDrawer,
  drawerStore,
  releaseDrawer,
  setDrawerTravel
} from '@renderer/lib/gestures/drawer'
import { capturePointer } from '@renderer/lib/gestures/pointerCapture'
import { SPRING_SNAPPY, SpringAnimation } from '@renderer/lib/motion/spring'
import { VelocityTracker } from '@renderer/lib/motion/velocity'
import { activeSpace, activeTab, essentialsFor, tabTitle, tabsOf } from '@renderer/lib/selectors'
import { openOverlay, uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { Favicon } from '../sidebar/Favicon'
import { SpaceGlyph } from '../SpaceGlyph'
import { useLongPress } from './useLongPress'

/** Movement (px) before a touch on the drawer is a swipe rather than a tap. */
const SLOP = 8
/** Height of a space row, with its gap: what one step of a reorder drag is worth. */
const ROW_HEIGHT = 48
/** How long a released hold waits for its click before opening the options regardless. */
const MENU_DELAY_MS = 250

interface Props {
  state: UIState
  isDark: boolean
}

/**
 * The phone's Spaces drawer: slides in over the tab overview from the sidebar's side and lists
 * the spaces – tap to switch, hold to pick a row up and drag it to reorder, or let go for the
 * space's options – with a shortcut to a new space and the theme picker, and the Essentials
 * below. Its position is `drawerStore.progress`: a spring, a finger pushing it back towards its
 * edge, or the system's predictive back gesture all drive the same number.
 */
export function SpacesDrawer({ state, isDark }: Props): JSX.Element {
  const drawer = drawerStore.use()
  const insets = uiStore.use((s) => s.insets)
  const side = state.settings.sidebarSide
  const space = activeSpace(state)
  const active = activeTab(state)
  const essentials = essentialsFor(state, space)
  const panelRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const width = panelRef.current?.offsetWidth
    if (width) setDrawerTravel(width)
  }, [])

  // The drawer is the top surface while it is up: Escape closes it (and only it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        closeSpacesDrawer()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // A sideways swipe on the drawer pushes it back out with the same physics that brought it in.
  const outward = side === 'left' ? -1 : 1
  const touch = useRef<{
    id: number
    x0: number
    y0: number
    mode: 'pending' | 'drag' | 'none'
    tracker: VelocityTracker
  } | null>(null)
  const finish = (e: ReactPointerEvent<HTMLElement>, cancelled: boolean): void => {
    const t = touch.current
    if (!t || t.id !== e.pointerId) return
    touch.current = null
    if (t.mode !== 'drag') return
    const { vx } = cancelled ? { vx: 0 } : t.tracker.velocity(e.timeStamp)
    releaseDrawer(vx * outward)
  }
  const swipe = {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0 || touch.current) return
      const tracker = new VelocityTracker()
      tracker.add(e.timeStamp, e.clientX, e.clientY)
      // Mid-flight the finger takes the drawer at once; at rest it waits for a real swipe.
      const caught = drawerStore.get().phase === 'settling' && beginDrawerDrag()
      touch.current = {
        id: e.pointerId,
        x0: e.clientX,
        y0: e.clientY,
        mode: caught ? 'drag' : 'pending',
        tracker
      }
      if (caught) capturePointer(e.currentTarget, e.pointerId)
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      const t = touch.current
      if (!t || t.id !== e.pointerId) return
      t.tracker.add(e.timeStamp, e.clientX, e.clientY)
      if (t.mode === 'pending') {
        const dx = e.clientX - t.x0
        const dy = e.clientY - t.y0
        if (Math.hypot(dx, dy) < SLOP) return
        if (Math.abs(dx) <= Math.abs(dy) || !beginDrawerDrag()) {
          t.mode = 'none'
          return
        }
        t.mode = 'drag'
        t.x0 = e.clientX
        capturePointer(e.currentTarget, e.pointerId)
      }
      if (t.mode === 'drag') dragDrawer((e.clientX - t.x0) * outward)
    },
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => finish(e, false),
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => finish(e, true)
  }

  const p = drawer.progress
  const shift = (1 - p) * 100 * outward
  const pickSpace = (id: string): void => {
    if (id !== state.activeSpaceId) run('space.activate', { spaceId: id })
    closeSpacesDrawer()
  }
  const pickTab = (tab: Tab): void => {
    run('tab.activate', { tabId: tab.id })
    closeSpacesDrawer()
  }

  const shown = Math.min(1, Math.max(0, p))
  return (
    <div className="absolute inset-0 z-40" data-shell-chrome onClick={() => closeSpacesDrawer()}>
      <div
        className="zen-overview-scrim pointer-events-none absolute inset-0"
        style={{ opacity: shown }}
      />
      <div
        ref={panelRef}
        className={cn(
          'zen-drawer-panel absolute inset-y-0 flex w-[min(84vw,360px)] flex-col',
          side === 'left' ? 'left-0' : 'right-0'
        )}
        data-side={side}
        style={{
          transform: `translateX(${shift}%)`,
          paddingTop: `calc(${insets.top}px + 8px)`,
          paddingBottom: `calc(${insets.bottom}px + 8px)`
        }}
        onClick={(e) => e.stopPropagation()}
        {...swipe}
      >
        <header className="flex h-14 shrink-0 items-center gap-2.5 pl-4 pr-2">
          <SpaceGlyph icon={space.icon} size={20} />
          <span className="zen-title min-w-0 flex-1 truncate">{space.name}</span>
          <button
            type="button"
            className="zen-toolbar-button h-11 w-11"
            aria-label="Change theme"
            onClick={() => void openOverlay('theme', active?.id ?? null, space.id)}
          >
            <Palette className="h-5 w-5" />
          </button>
          <button
            type="button"
            className="zen-toolbar-button h-11 w-11"
            aria-label="New space"
            onClick={() => void openOverlay('space-editor', active?.id ?? null, null)}
          >
            <Plus className="h-5 w-5" />
          </button>
        </header>
        <div
          className="min-h-0 flex-1 overflow-y-auto px-2 pt-1"
          style={{ touchAction: 'pan-y', overscrollBehavior: 'contain' }}
        >
          <SpaceList state={state} isDark={isDark} onPick={pickSpace} />
          {essentials.length > 0 && (
            <section className="pt-4">
              <h3 className="px-2 pb-2 text-[14px] font-semibold text-[var(--zen-fg)]">
                Essentials
              </h3>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(52px,1fr))] gap-1.5 px-1">
                {essentials.map((tab) => (
                  <EssentialTile
                    key={tab.id}
                    tab={tab}
                    active={tab.id === active?.id}
                    onPick={pickTab}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Spaces: switch, reorder, options
// ---------------------------------------------------------------------------

/** How long a finger rests on a row before the row comes off the list. */
const HOLD_MS = 380
/** Movement (px) that turns a held row into a reorder drag, or a touch into a scroll. */
const ROW_SLOP = 8

interface Held {
  spaceId: string
  from: number
  /** Finger travel since the hold began, px (0 until the row is actually dragged). */
  dy: number
  /** Slot the row would land in if released now. */
  to: number
  dragging: boolean
}

/**
 * The spaces as rows. Tap switches; hold picks the row up (the same hold as a tab card in the
 * overview) – drag it to reorder, or let go in place for the space's options (edit, theme,
 * delete). The other rows step aside as the held row passes them.
 */
function SpaceList({
  state,
  isDark,
  onPick
}: {
  state: UIState
  isDark: boolean
  onPick: (spaceId: string) => void
}): JSX.Element {
  const [held, setHeld] = useState<Held | null>(null)
  // After a drop the moved row springs the last stretch into its new slot.
  const [landing, setLanding] = useState<{ spaceId: string; offset: number } | null>(null)
  const landingSpring = useMemo(
    () =>
      new SpringAnimation(
        SPRING_SNAPPY,
        (offset) => setLanding((l) => (l ? { ...l, offset } : l)),
        () => setLanding(null)
      ),
    []
  )
  useEffect(
    () => () => {
      landingSpring.stop()
    },
    [landingSpring]
  )

  const pendingMenu = useRef<{ spaceId: string; timer: ReturnType<typeof setTimeout> } | null>(null)
  const openPendingMenu = (): void => {
    const pending = pendingMenu.current
    if (!pending) return
    clearTimeout(pending.timer)
    pendingMenu.current = null
    run('space.contextMenu', { spaceId: pending.spaceId })
  }
  useEffect(
    () => () => {
      if (pendingMenu.current) clearTimeout(pendingMenu.current.timer)
    },
    []
  )

  const spaces = state.spaces
  const slotFor = (index: number, dy: number): number =>
    Math.max(0, Math.min(spaces.length - 1, Math.round(index + dy / ROW_HEIGHT)))

  const hold = (e: ReactPointerEvent<HTMLElement>, space: Space, index: number): boolean => {
    if (e.button !== 0 || held) return false
    const el = e.currentTarget
    const pointerId = e.pointerId
    const x0 = e.clientX
    const y0 = e.clientY
    let lifted = false
    let dragging = false
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      timer = null
      lifted = true
      landingSpring.stop()
      setLanding(null)
      setHeld({ spaceId: space.id, from: index, dy: 0, to: index, dragging: false })
      try {
        capturePointer(el, pointerId)
      } catch {
        /* the pointer is gone */
      }
      document.addEventListener('touchmove', blockTouchScroll, { passive: false })
      navigator.vibrate?.(8)
    }, HOLD_MS)
    const cleanup = (): void => {
      if (timer) clearTimeout(timer)
      timer = null
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onCancel)
      document.removeEventListener('touchmove', blockTouchScroll)
    }
    const onMove = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return
      const dy = ev.clientY - y0
      const moved = Math.hypot(ev.clientX - x0, dy) >= ROW_SLOP
      if (!lifted) {
        // A finger that moves before the hold is over is scrolling the drawer.
        if (moved) cleanup()
        return
      }
      if (moved) dragging = true
      if (dragging) setHeld((h) => (h ? { ...h, dy, to: slotFor(index, dy), dragging: true } : h))
    }
    const settle = (dy: number): void => {
      const to = slotFor(index, dy)
      setHeld(null)
      if (to !== index) run('space.reorder', { spaceId: space.id, index: to })
      // The row is drawn where the finger left it; its slot is `to` rows away from home.
      const remaining = dy - (to - index) * ROW_HEIGHT
      if (remaining !== 0) {
        setLanding({ spaceId: space.id, offset: remaining })
        landingSpring.start(remaining, 0, 0)
      }
    }
    const onUp = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return
      cleanup()
      if (!lifted) return
      if (dragging) settle(ev.clientY - y0)
      else {
        settle(0)
        // The options open on the click that follows the release (so the menu's scrim cannot
        // receive that same click), or after a moment if none comes.
        if (pendingMenu.current) clearTimeout(pendingMenu.current.timer)
        pendingMenu.current = {
          spaceId: space.id,
          timer: setTimeout(() => openPendingMenu(), MENU_DELAY_MS)
        }
      }
    }
    const onCancel = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return
      cleanup()
      if (lifted) settle(0)
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onCancel)
    return true
  }

  return (
    <ul className="flex flex-col" aria-label="Spaces">
      {spaces.map((space, index) => {
        let offset = 0
        let isHeld = false
        if (held) {
          if (held.spaceId === space.id) {
            offset = held.dy
            isHeld = true
          } else if (held.from < index && index <= held.to) offset = -ROW_HEIGHT
          else if (held.to <= index && index < held.from) offset = ROW_HEIGHT
        } else if (landing?.spaceId === space.id) offset = landing.offset
        return (
          <SpaceRow
            key={space.id}
            state={state}
            space={space}
            isDark={isDark}
            active={space.id === state.activeSpaceId}
            held={isHeld}
            stepping={Boolean(held) && !isHeld}
            offset={offset}
            onPick={() => onPick(space.id)}
            onHold={(e) => hold(e, space, index)}
            onHeldClick={openPendingMenu}
          />
        )
      })}
    </ul>
  )
}

/** A touch that has picked a row up must not scroll the drawer; touch-action is too late for that. */
function blockTouchScroll(e: TouchEvent): void {
  if (e.cancelable) e.preventDefault()
}

function SpaceRow({
  state,
  space,
  isDark,
  active,
  held,
  stepping,
  offset,
  onPick,
  onHold,
  onHeldClick
}: {
  state: UIState
  space: Space
  isDark: boolean
  active: boolean
  /** In the hand: lifted off the list, following the finger. */
  held: boolean
  /** Another row is in the hand: this one steps aside with a transition. */
  stepping: boolean
  offset: number
  onPick: () => void
  /** Pointer down on the row; returns true when the touch is being watched for a hold. */
  onHold: (e: ReactPointerEvent<HTMLElement>) => boolean
  /** The click after a hold released in place: open the options now. */
  onHeldClick: () => void
}): JSX.Element {
  const count = tabsOf(state, space).length
  const swatch = space.theme ? rgbToHex(resolveTheme(space.theme, isDark).accent) : null
  const wasHeld = useRef(false)
  const style: CSSProperties = {
    transform: offset || held ? `translateY(${offset}px)${held ? ' scale(1.02)' : ''}` : undefined,
    transition: stepping ? 'transform 220ms var(--zen-ease)' : undefined,
    zIndex: held ? 1 : undefined
  }
  return (
    <li
      className="zen-space-row relative flex h-12 items-center gap-3 rounded-[10px] pl-2 pr-3"
      data-active={active}
      data-held={held || undefined}
      style={style}
      role="button"
      tabIndex={0}
      aria-label={space.name}
      aria-current={active || undefined}
      onPointerDown={(e) => {
        wasHeld.current = false
        onHold(e)
      }}
      onPointerUp={() => {
        // A hold (with or without a drag) ends here; the click that follows is not a pick.
        if (held) wasHeld.current = true
      }}
      onClick={() => {
        if (wasHeld.current) {
          wasHeld.current = false
          onHeldClick()
          return
        }
        onPick()
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        run('space.contextMenu', { spaceId: space.id })
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onPick()
      }}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center">
        <SpaceGlyph icon={space.icon} size={20} dotColor={swatch ?? undefined} />
      </span>
      <span className="min-w-0 flex-1 truncate text-[14px]">{space.name}</span>
      <span className="shrink-0 text-[13px] tabular-nums text-[var(--zen-muted)]">
        {count} tab{count === 1 ? '' : 's'}
      </span>
    </li>
  )
}

// ---------------------------------------------------------------------------
// Essentials
// ---------------------------------------------------------------------------

function EssentialTile({
  tab,
  active,
  onPick
}: {
  tab: Tab
  active: boolean
  onPick: (tab: Tab) => void
}): JSX.Element {
  const press = useLongPress(() => run('tab.contextMenu', { tabId: tab.id }))
  return (
    <button
      type="button"
      className="zen-essential h-12"
      data-active={active}
      data-discarded={tab.discarded}
      aria-label={tabTitle(tab)}
      onClick={() => {
        if (!press.swallowsClick()) onPick(tab)
      }}
      {...press.handlers}
    >
      <Favicon tab={tab} size={22} />
    </button>
  )
}
