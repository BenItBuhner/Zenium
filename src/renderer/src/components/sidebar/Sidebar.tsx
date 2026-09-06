import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { FolderInput, VenetianMask } from 'lucide-react'
import type { UIState } from '@shared/types'
import { cmd, run } from '@renderer/lib/api'
import {
  activeSpace,
  activeTab,
  essentialsFor,
  isLocalWindow,
  isPrivateWindow
} from '@renderer/lib/selectors'
import { uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { Essentials } from './Essentials'
import { SidebarBottom } from './SidebarBottom'
import { SidebarTop } from './SidebarTop'
import { SpacePanel } from './SpacePanel'

interface Props {
  state: UIState
  isDark: boolean
  /** Floating over the content (compact mode hover reveal). */
  floating?: boolean
  onPointerLeave?: () => void
}

const COLLAPSED_WIDTH = 56

export function Sidebar({ state, isDark, floating, onPointerLeave }: Props): JSX.Element {
  const space = activeSpace(state)
  const tab = activeTab(state)
  const compact = !state.settings.sidebarExpanded
  const local = isLocalWindow(state)
  const width = compact ? COLLAPSED_WIDTH : 'var(--zen-sidebar-width)'
  const activeIndex = Math.max(
    0,
    state.spaces.findIndex((s) => s.id === state.activeSpaceId)
  )
  const essentials = local ? [] : essentialsFor(state, space)
  const showToolbar = state.settings.toolbarLayout !== 'multiple'
  const side = state.settings.sidebarSide

  return (
    <aside
      className={cn(
        'relative flex h-full shrink-0 flex-col',
        floating && 'zen-panel zen-animate-in'
      )}
      style={{ width }}
      onPointerLeave={onPointerLeave}
      data-side={side}
    >
      <SidebarTop state={state} tab={tab} compact={compact} showToolbar={showToolbar} />
      {local ? (
        <LocalWindowHeader state={state} compact={compact} />
      ) : (
        <Essentials essentials={essentials} activeTabId={space.activeTabId} compact={compact} />
      )}
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
      {!compact && !floating && <Resizer state={state} />}
    </aside>
  )
}

/**
 * Blank / private windows have no Essentials or spaces; Zen shows what the window is and a
 * "Move to…" helper to bring the tabs back into a real space.
 */
function LocalWindowHeader({ state, compact }: { state: UIState; compact: boolean }): JSX.Element {
  const isPrivate = isPrivateWindow(state)
  const space = activeSpace(state)
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  const canMove = space.tabIds.length > 0
  return (
    <div
      className={cn(
        'relative mx-2 mb-1 flex items-center gap-2 px-2 py-1.5 text-[12px] text-[var(--zen-muted)]',
        compact && 'justify-center px-0'
      )}
    >
      {isPrivate ? (
        <VenetianMask className="h-4 w-4 shrink-0" />
      ) : (
        <span className="text-sm leading-none">◫</span>
      )}
      {!compact && (
        <span className="min-w-0 flex-1 truncate font-medium">
          {isPrivate ? 'Private Browsing' : 'Blank window'}
        </span>
      )}
      {!compact && (
        <button
          type="button"
          className="zen-toolbar-button h-6 w-6"
          title="Move these tabs to a space…"
          disabled={!canMove}
          onClick={() => setOpen(!open)}
        >
          <FolderInput className="h-3.5 w-3.5" />
        </button>
      )}
      {open && (
        <div
          ref={menuRef}
          className="zen-panel zen-animate-in absolute right-0 top-full z-30 mt-1 w-56 p-1"
        >
          <div className="px-2 py-1 text-[11px] uppercase tracking-wide text-[var(--zen-muted)]">
            Move tabs to
          </div>
          <MoveTargets
            onPick={(spaceId) => {
              setOpen(false)
              run('window.moveTabsToSpace', { spaceId })
            }}
          />
        </div>
      )}
    </div>
  )
}

/** Blank windows only see their own space in the snapshot; the real spaces are fetched on demand. */
function MoveTargets({ onPick }: { onPick: (spaceId: string) => void }): JSX.Element {
  const [spaces, setSpaces] = useState<Array<{ id: string; name: string; icon: string }>>([])
  useEffect(() => {
    let cancelled = false
    void cmd('app.listSpaces', undefined).then((list) => {
      if (!cancelled) setSpaces(list)
    })
    return () => {
      cancelled = true
    }
  }, [])
  if (!spaces.length)
    return <div className="px-2 py-2 text-[12px] text-[var(--zen-muted)]">No spaces</div>
  return (
    <>
      {spaces.map((s) => (
        <button
          key={s.id}
          type="button"
          className="zen-squircle flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] hover:bg-[var(--zen-element-bg)]"
          onClick={() => onPick(s.id)}
        >
          <span className="text-sm leading-none">{s.icon || '◦'}</span>
          <span className="min-w-0 flex-1 truncate">{s.name}</span>
        </button>
      ))}
    </>
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
