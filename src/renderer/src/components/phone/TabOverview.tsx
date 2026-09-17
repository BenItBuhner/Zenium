import type { JSX } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { PanelLeft, Plus, X } from 'lucide-react'
import type { Folder, Rect, Space, Tab, UIState } from '@shared/types'
import { useFadeEdges } from '@renderer/hooks/useFadeEdges'
import { run } from '@renderer/lib/api'
import { closeOverview, type OverviewState } from '@renderer/lib/gestures/stage'
import {
  activeSpace,
  activeTab,
  essentialsFor,
  pinnedOf,
  regularOf,
  tabTitle
} from '@renderer/lib/selectors'
import { openDrawer } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { Favicon } from '../sidebar/Favicon'
import { SpaceGlyph } from '../SpaceGlyph'
import { TabPreview } from './TabPreview'
import { useOverviewHandle } from './usePillGestures'

/** Corner radius of a tab card; the page morphs from the content radius down to this. */
const CARD_RADIUS = 14
/** Height of a card's title row. */
const CARD_HEADER = 40

interface Props {
  state: UIState
  overview: OverviewState
  /** Where the page normally is, in window coordinates. */
  area: Rect
}

/**
 * The tab overview of the phone layout: the active space's tabs as a grid of thumbnail cards –
 * Essentials on top, pinned tabs first, folders as labelled groups – with the other spaces as a
 * strip of chips. Its entrance is driven by `overview.progress`: the grid scales and fades in
 * while the page shrinks into the slot of its own card (and grows back out of the card that is
 * picked when leaving), so a half-finished drag always shows exactly where things are going.
 */
export function TabOverview({ state, overview, area }: Props): JSX.Element {
  const { progress, phase, heroTabId } = overview
  const space = activeSpace(state)
  const active = activeTab(state)
  const essentials = essentialsFor(state, space)
  const pinned = pinnedOf(state, space)
  const regular = regularOf(state, space)
  const folders = Object.values(state.folders).filter((f) => f.spaceId === space.id)
  const loose = regular.filter((t) => !t.folderId || !state.folders[t.folderId])
  const count = essentials.length + pinned.length + regular.length
  const hero = heroTabId ? (state.tabs[heroTabId] ?? null) : null
  const p = Math.min(1, Math.max(0, progress))
  const interactive = phase === 'open'

  const rootRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const fadeGrid = useFadeEdges<HTMLDivElement>({ axis: 'y' })
  const cells = useRef(new Map<string, HTMLElement>())
  const [heroCell, setHeroCell] = useState<Rect | null>(null)
  const handle = useOverviewHandle({ edge: 'bottom' })

  // Where the hero's own card sits, in layout space (the root's entrance scale divided out).
  const cardsKey = [...essentials, ...pinned, ...regular].map((t) => t.id).join('|')
  const measure = (): void => {
    const root = rootRef.current
    const cell = heroTabId ? cells.current.get(heroTabId) : undefined
    if (!root || !cell) {
      setHeroCell(null)
      return
    }
    const r = cell.getBoundingClientRect()
    const rr = root.getBoundingClientRect()
    const scale = root.offsetWidth ? rr.width / root.offsetWidth : 1
    const cx = rr.left + rr.width / 2
    const cy = rr.top + rr.height / 2
    setHeroCell({
      x: cx + (r.left - cx) / scale,
      y: cy + (r.top - cy) / scale,
      width: r.width / scale,
      height: r.height / scale
    })
  }
  useLayoutEffect(() => {
    const cell = heroTabId ? cells.current.get(heroTabId) : undefined
    // The page morphs out of / into its card: make sure that card is fully on screen first.
    const morphing = (phase === 'dragging' && progress < 0.05) || phase === 'settling'
    if (cell && morphing) cell.scrollIntoView({ block: 'nearest' })
    measure()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-measure when the layout inputs change
  }, [heroTabId, cardsKey, area.width, area.height, phase])

  useEffect(() => {
    if (!interactive) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeOverview()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [interactive])

  const pick = (tab: Tab): void => closeOverview(tab.id)
  const register = (id: string) => (el: HTMLElement | null) => {
    if (el) cells.current.set(id, el)
    else cells.current.delete(id)
  }
  const card = (tab: Tab): JSX.Element => (
    <OverviewCard
      key={tab.id}
      ref={register(tab.id)}
      tab={tab}
      active={tab.id === active?.id}
      hidden={tab.id === heroTabId && p < 1}
      onPick={pick}
    />
  )

  const heroRect = hero ? lerpRect(area, heroCell ?? shrunk(area), p) : null
  const contentRadius =
    parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--zen-content-radius')
    ) || 12

  return (
    <>
      <div
        className="absolute"
        style={{
          left: 'var(--zen-inset-left)',
          right: 'var(--zen-inset-right)',
          top: 'var(--zen-inset-top)',
          bottom: 'calc(var(--zen-phone-bar) + var(--zen-inset-bottom))',
          pointerEvents: interactive ? 'auto' : 'none'
        }}
      >
        <div
          ref={rootRef}
          className="zen-overview absolute inset-0 flex flex-col"
          style={{
            opacity: Math.min(1, p * 1.6),
            transform: `scale(${0.94 + 0.06 * p})`
          }}
        >
          <header className="flex h-12 shrink-0 items-center gap-2 px-3" {...handle}>
            <SpaceGlyph icon={space.icon} size={16} />
            <span className="min-w-0 truncate text-[15px] font-semibold">{space.name}</span>
            <span className="shrink-0 text-[12px] text-[var(--zen-muted)]">
              {count} tab{count === 1 ? '' : 's'}
            </span>
            <span className="flex-1" />
            <button
              type="button"
              className="zen-toolbar-button h-9 w-9"
              aria-label="Open sidebar"
              onClick={() => void openDrawer(active?.id ?? null)}
            >
              <PanelLeft className="h-[18px] w-[18px]" />
            </button>
          </header>
          {state.spaces.length > 1 && <SpaceStrip spaces={state.spaces} activeId={space.id} />}
          <div
            ref={(el) => {
              scrollRef.current = el
              return fadeGrid(el)
            }}
            className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-1"
            style={{ touchAction: 'pan-y', overscrollBehavior: 'contain' }}
            onScroll={measure}
          >
            {essentials.length > 0 && (
              <div className="mb-3 flex flex-wrap gap-2">
                {essentials.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    className="zen-essential h-12 w-12"
                    data-active={tab.id === active?.id}
                    data-discarded={tab.discarded}
                    aria-label={tabTitle(tab)}
                    onClick={() => pick(tab)}
                  >
                    <Favicon tab={tab} size={22} />
                  </button>
                ))}
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              {pinned.map(card)}
              {folders.map((folder) => (
                <FolderGroup
                  key={folder.id}
                  folder={folder}
                  tabs={regular.filter((t) => t.folderId === folder.id)}
                  card={card}
                />
              ))}
              {loose.map(card)}
              <NewTabCard />
            </div>
          </div>
        </div>
      </div>
      {hero && heroRect && p < 1 && (
        <div
          className="zen-stage-card zen-overview-hero pointer-events-none absolute flex flex-col"
          style={{
            left: heroRect.x,
            top: heroRect.y,
            width: heroRect.width,
            height: heroRect.height,
            borderRadius: contentRadius + (CARD_RADIUS - contentRadius) * p
          }}
        >
          <div
            className="flex shrink-0 items-center gap-2 overflow-hidden pl-3 pr-1"
            style={{ height: CARD_HEADER * p, opacity: p }}
          >
            <Favicon tab={hero} size={16} />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
              {tabTitle(hero)}
            </span>
          </div>
          <div className="relative min-h-0 flex-1 overflow-hidden">
            <TabPreview tab={hero} scale={1 - 0.2 * p} />
          </div>
        </div>
      )}
    </>
  )
}

interface CardProps {
  tab: Tab
  active: boolean
  /** The hero stands in for this card while the page morphs into it. */
  hidden: boolean
  onPick: (tab: Tab) => void
  ref: (el: HTMLDivElement | null) => void
}

function OverviewCard({ tab, active, hidden, onPick, ref }: CardProps): JSX.Element {
  return (
    <div ref={ref} className="relative" style={{ aspectRatio: '3 / 4' }} data-tab-id={tab.id}>
      <div
        role="button"
        tabIndex={0}
        className="zen-overview-card absolute inset-0 flex flex-col overflow-hidden"
        data-active={active}
        style={{ opacity: hidden ? 0 : 1 }}
        aria-label={tabTitle(tab)}
        onClick={() => onPick(tab)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') onPick(tab)
        }}
      >
        <header
          className="flex shrink-0 items-center gap-2 pl-3 pr-1"
          style={{ height: CARD_HEADER }}
        >
          <Favicon tab={tab} size={16} />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{tabTitle(tab)}</span>
          <button
            type="button"
            className="zen-toolbar-button h-8 w-8 rounded-[10px]"
            aria-label="Close tab"
            onClick={(e) => {
              e.stopPropagation()
              run('tab.close', { tabId: tab.id })
            }}
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <TabPreview tab={tab} scale={0.8} />
        </div>
      </div>
    </div>
  )
}

function FolderGroup({
  folder,
  tabs,
  card
}: {
  folder: Folder
  tabs: Tab[]
  card: (tab: Tab) => JSX.Element
}): JSX.Element | null {
  if (tabs.length === 0) return null
  return (
    <>
      <div className="col-span-2 flex items-center gap-2 px-1 pt-2 text-[12px] font-medium text-[var(--zen-muted)]">
        <span className="text-[13px] leading-none">{folder.icon}</span>
        <span className="min-w-0 truncate">{folder.name}</span>
        <span>{tabs.length}</span>
      </div>
      {tabs.map(card)}
    </>
  )
}

function NewTabCard(): JSX.Element {
  return (
    <button
      type="button"
      className="zen-overview-new flex flex-col items-center justify-center gap-2 text-[var(--zen-muted)] active:text-[var(--zen-fg)]"
      style={{ aspectRatio: '3 / 4' }}
      onClick={() => window.dispatchEvent(new CustomEvent('zen-new-tab'))}
    >
      <Plus className="h-6 w-6" />
      <span className="text-[13px] font-medium">New Tab</span>
    </button>
  )
}

function SpaceStrip({ spaces, activeId }: { spaces: Space[]; activeId: string }): JSX.Element {
  const fade = useFadeEdges<HTMLDivElement>({ axis: 'x', size: 24 })
  return (
    <div
      ref={fade}
      className="zen-overview-strip flex shrink-0 gap-2 overflow-x-auto px-3 pb-2 pt-1"
    >
      {spaces.map((s) => (
        <button
          key={s.id}
          type="button"
          className={cn(
            'flex h-9 shrink-0 items-center gap-2 rounded-full px-3.5 text-[13px] font-medium',
            s.id === activeId ? 'bg-[var(--zen-element-bg-active)]' : 'bg-[var(--zen-element-bg)]'
          )}
          onClick={() => run('space.activate', { spaceId: s.id })}
        >
          <SpaceGlyph icon={s.icon} size={14} />
          <span className="max-w-[140px] truncate">{s.name}</span>
        </button>
      ))}
    </div>
  )
}

function lerpRect(a: Rect, b: Rect, t: number): Rect {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    width: a.width + (b.width - a.width) * t,
    height: a.height + (b.height - a.height) * t
  }
}

/** Fallback destination when the hero has no card (a tab of another space): shrink in place. */
function shrunk(area: Rect): Rect {
  return {
    x: area.x + area.width * 0.25,
    y: area.y + area.height * 0.25,
    width: area.width * 0.5,
    height: area.height * 0.5
  }
}
