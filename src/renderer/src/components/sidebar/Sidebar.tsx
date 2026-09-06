import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import type { UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { useViewport } from '@renderer/lib/formFactor'
import { activeSpace, activeTab, essentialsFor } from '@renderer/lib/selectors'
import { uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { Essentials } from './Essentials'
import { SidebarBottom } from './SidebarBottom'
import { SidebarTop } from './SidebarTop'
import { SpacePanel } from './SpacePanel'

interface Props {
  state: UIState
  isDark: boolean
  /** Floating over the content (compact mode hover reveal, phone drawer). */
  floating?: boolean
  /** Phone drawer: navigation lives in the bottom bar, not in the sidebar. */
  hideNav?: boolean
  className?: string
  onPointerLeave?: () => void
}

const COLLAPSED_WIDTH = 56

export function Sidebar({
  state,
  isDark,
  floating,
  hideNav,
  className,
  onPointerLeave
}: Props): JSX.Element {
  const space = activeSpace(state)
  const tab = activeTab(state)
  const { coarse } = useViewport()
  const compact = !state.settings.sidebarExpanded && !hideNav
  const width = compact ? COLLAPSED_WIDTH : 'var(--zen-sidebar-width)'
  const activeIndex = Math.max(
    0,
    state.spaces.findIndex((s) => s.id === state.activeSpaceId)
  )
  const essentials = essentialsFor(state, space)
  const showToolbar = state.settings.toolbarLayout !== 'multiple' && !hideNav
  const side = state.settings.sidebarSide

  return (
    <aside
      className={cn(
        'relative flex h-full shrink-0 flex-col',
        floating && 'zen-panel zen-animate-in',
        className
      )}
      style={className ? undefined : { width }}
      onPointerLeave={onPointerLeave}
      data-side={side}
    >
      <SidebarTop state={state} tab={tab} compact={compact} showToolbar={showToolbar} />
      <Essentials essentials={essentials} activeTabId={space.activeTabId} compact={compact} />
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div
          className="zen-space-strip h-full"
          style={{
            transform: `translateX(-${activeIndex * 100}%)`,
            width: `${state.spaces.length * 100}%`
          }}
        >
          {state.spaces.map((s) => (
            <div key={s.id} className="h-full" style={{ width: `${100 / state.spaces.length}%` }}>
              <SpacePanel
                state={state}
                space={s}
                isActive={s.id === state.activeSpaceId}
                compact={compact}
              />
            </div>
          ))}
        </div>
      </div>
      <SidebarBottom state={state} compact={compact} isDark={isDark} />
      {!compact && !floating && !coarse && <Resizer state={state} />}
    </aside>
  )
}

/** Drag handle on the sidebar's inner edge. */
function Resizer({ state }: { state: UIState }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const side = state.settings.sidebarSide
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let startX = 0
    let startWidth = 0
    const onMove = (e: PointerEvent): void => {
      const delta = side === 'left' ? e.clientX - startX : startX - e.clientX
      const width = Math.max(160, Math.min(520, startWidth + delta))
      document.documentElement.style.setProperty('--zen-sidebar-width', `${width}px`)
      el.dataset.width = String(width)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      const width = Number(el.dataset.width)
      if (width) run('sidebar.setWidth', { width })
      uiStore.set({ statusText: '' })
    }
    const onDown = (e: PointerEvent): void => {
      if (e.button !== 0) return
      e.preventDefault()
      startX = e.clientX
      startWidth =
        parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--zen-sidebar-width')
        ) || 240
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    }
    el.addEventListener('pointerdown', onDown)
    return () => el.removeEventListener('pointerdown', onDown)
  }, [side])
  return (
    <div
      ref={ref}
      className={cn(
        'zen-resizer zen-no-drag absolute top-0 h-full w-1.5 hover:bg-[var(--zen-accent)]/30',
        side === 'left' ? '-right-0.5' : '-left-0.5'
      )}
      title="Drag to resize · double-click to collapse"
      onDoubleClick={() => run('sidebar.toggleExpanded', undefined)}
    />
  )
}
