import type { CSSProperties, JSX, PointerEvent as ReactPointerEvent } from 'react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { GripVertical, MoreHorizontal, Palette, Plus } from 'lucide-react'
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
const ROW_HEIGHT = 56

interface Props {
  state: UIState
  isDark: boolean
}

/**
 * The phone's Spaces drawer: slides in over the tab overview from the sidebar's side and lists
 * the spaces – tap to switch, hold to rename, drag the grip to reorder, the row menu for the
 * rest – with a shortcut to a new space and the theme picker, and the Essentials below. Its
 * position is `drawerStore.progress`: a spring, a finger pushing it back towards its edge, or
 * the system's predictive back gesture all drive the same number.
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
      if (caught) e.currentTarget.setPointerCapture(e.pointerId)
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
        e.currentTarget.setPointerCapture(e.pointerId)
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

  return (
    <div
      className="absolute inset-0 z-40"
      style={{ background: `rgb(0 0 0 / ${0.32 * Math.min(1, Math.max(0, p))})` }}
      onClick={() => closeSpacesDrawer()}
    >
      <div
        ref={panelRef}
        className={cn(
          'zen-drawer-panel absolute inset-y-0 flex w-[min(320px,calc(100%-56px))] flex-col',
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
        <header className="flex h-12 shrink-0 items-center gap-1 pl-4 pr-2">
          <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">Spaces</span>
          <button
            type="button"
            className="zen-toolbar-button h-9 w-9"
            aria-label="Change theme"
            onClick={() => void openOverlay('theme', active?.id ?? null, space.id)}
          >
            <Palette className="h-[18px] w-[18px]" />
          </button>
          <button
            type="button"
            className="zen-toolbar-button h-9 w-9"
            aria-label="New space"
            onClick={() => void openOverlay('space-editor', active?.id ?? null, null)}
          >
            <Plus className="h-[18px] w-[18px]" />
          </button>
        </header>
        <div
          className="min-h-0 flex-1 overflow-y-auto px-2"
          style={{ touchAction: 'pan-y', overscrollBehavior: 'contain' }}
        >
          <SpaceList state={state} isDark={isDark} onPick={pickSpace} />
          {essentials.length > 0 && (
            <section className="pt-5">
              <h3 className="px-2 pb-2 text-[12px] font-medium text-[var(--zen-muted)]">
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
// Spaces: switch, rename, reorder
// ---------------------------------------------------------------------------

interface Reorder {
  spaceId: string
  from: number
  /** Finger travel since the grip was taken, px. */
  dy: number
  /** Slot the row would land in if released now. */
  to: number
}

function SpaceList({
  state,
  isDark,
  onPick
}: {
  state: UIState
  isDark: boolean
  onPick: (spaceId: string) => void
}): JSX.Element {
  const [reorder, setReorder] = useState<Reorder | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
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

  const spaces = state.spaces
  const grip = {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>, space: Space, index: number) => {
      if (e.button !== 0 || reorder) return
      e.stopPropagation()
      e.currentTarget.setPointerCapture(e.pointerId)
      landingSpring.stop()
      setLanding(null)
      setReorder({ spaceId: space.id, from: index, dy: 0, to: index })
      const y0 = e.clientY
      const el = e.currentTarget
      const onMove = (ev: PointerEvent): void => {
        if (ev.pointerId !== e.pointerId) return
        const dy = ev.clientY - y0
        const to = Math.max(0, Math.min(spaces.length - 1, Math.round(index + dy / ROW_HEIGHT)))
        setReorder((r) => (r ? { ...r, dy, to } : r))
      }
      const onUp = (ev: PointerEvent): void => {
        if (ev.pointerId !== e.pointerId) return
        el.removeEventListener('pointermove', onMove)
        el.removeEventListener('pointerup', onUp)
        el.removeEventListener('pointercancel', onUp)
        const dy = ev.type === 'pointercancel' ? 0 : ev.clientY - y0
        const to =
          ev.type === 'pointercancel'
            ? index
            : Math.max(0, Math.min(spaces.length - 1, Math.round(index + dy / ROW_HEIGHT)))
        setReorder(null)
        if (to !== index) run('space.reorder', { spaceId: space.id, index: to })
        // The row is drawn where the finger left it; its slot is `to` rows away from home.
        const remaining = dy - (to - index) * ROW_HEIGHT
        setLanding({ spaceId: space.id, offset: remaining })
        landingSpring.start(remaining, 0, 0)
      }
      el.addEventListener('pointermove', onMove)
      el.addEventListener('pointerup', onUp)
      el.addEventListener('pointercancel', onUp)
    }
  }

  return (
    <ul className="flex flex-col gap-1" aria-label="Spaces">
      {spaces.map((space, index) => {
        let offset = 0
        let dragged = false
        if (reorder) {
          if (reorder.spaceId === space.id) {
            offset = reorder.dy
            dragged = true
          } else if (reorder.from < index && index <= reorder.to) offset = -ROW_HEIGHT
          else if (reorder.to <= index && index < reorder.from) offset = ROW_HEIGHT
        } else if (landing?.spaceId === space.id) offset = landing.offset
        return (
          <SpaceRow
            key={space.id}
            state={state}
            space={space}
            isDark={isDark}
            active={space.id === state.activeSpaceId}
            dragged={dragged}
            settling={Boolean(reorder) && !dragged}
            offset={offset}
            renaming={renamingId === space.id}
            onRename={(on) => setRenamingId(on ? space.id : null)}
            onPick={() => onPick(space.id)}
            onGrip={(e) => grip.onPointerDown(e, space, index)}
          />
        )
      })}
    </ul>
  )
}

function SpaceRow({
  state,
  space,
  isDark,
  active,
  dragged,
  settling,
  offset,
  renaming,
  onRename,
  onPick,
  onGrip
}: {
  state: UIState
  space: Space
  isDark: boolean
  active: boolean
  dragged: boolean
  /** Another row is being dragged: this one slides out of the way with a transition. */
  settling: boolean
  offset: number
  renaming: boolean
  onRename: (on: boolean) => void
  onPick: () => void
  onGrip: (e: ReactPointerEvent<HTMLElement>) => void
}): JSX.Element {
  const count = tabsOf(state, space).length
  const swatch = space.theme ? rgbToHex(resolveTheme(space.theme, isDark).accent) : null
  const press = useLongPress(() => onRename(true))
  const style: CSSProperties = {
    transform: offset ? `translateY(${offset}px)${dragged ? ' scale(1.02)' : ''}` : undefined,
    transition: settling ? 'transform 220ms var(--zen-ease)' : undefined,
    zIndex: dragged ? 1 : undefined
  }
  return (
    <li
      className={cn('zen-space-row relative flex h-[52px] items-center gap-2 rounded-[14px] pr-1')}
      data-active={active}
      data-dragged={dragged || undefined}
      style={style}
      role="button"
      tabIndex={0}
      aria-label={space.name}
      aria-current={active || undefined}
      onClick={() => {
        if (press.swallowsClick() || renaming) return
        onPick()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onPick()
      }}
      {...press.handlers}
    >
      <span
        className="flex h-full w-8 shrink-0 cursor-grab touch-none items-center justify-center text-[var(--zen-muted)]"
        aria-label={`Reorder ${space.name}`}
        role="button"
        onPointerDown={onGrip}
      >
        <GripVertical className="h-4 w-4 opacity-60" />
      </span>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center">
        <SpaceGlyph icon={space.icon} size={18} dotColor={swatch ?? undefined} />
      </span>
      {renaming ? (
        <SpaceRename space={space} onDone={() => onRename(false)} />
      ) : (
        <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{space.name}</span>
      )}
      <span className="shrink-0 text-[12px] tabular-nums text-[var(--zen-muted)]">
        {count} tab{count === 1 ? '' : 's'}
      </span>
      <button
        type="button"
        className="zen-toolbar-button h-9 w-9"
        aria-label={`Options for ${space.name}`}
        onClick={(e) => {
          e.stopPropagation()
          run('space.contextMenu', { spaceId: space.id })
        }}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
    </li>
  )
}

function SpaceRename({ space, onDone }: { space: Space; onDone: () => void }): JSX.Element {
  const [value, setValue] = useState(space.name)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const commit = (save: boolean): void => {
    onDone()
    const name = value.trim()
    if (save && name && name !== space.name)
      run('space.update', { spaceId: space.id, patch: { name } })
  }
  return (
    <input
      ref={ref}
      value={value}
      aria-label="Space name"
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => commit(true)}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit(true)
        if (e.key === 'Escape') commit(false)
        e.stopPropagation()
      }}
      className="min-w-0 flex-1 rounded-[9px] bg-[var(--zen-element-bg)] px-2 py-1 text-[14px] font-medium outline-none"
    />
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
