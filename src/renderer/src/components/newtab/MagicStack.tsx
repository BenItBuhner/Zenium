import type { JSX, ReactNode, RefObject, UIEvent } from 'react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Bookmark,
  Download,
  EllipsisVertical,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileText,
  FileVideo,
  Globe,
  History,
  Image,
  Package,
  type LucideIcon
} from 'lucide-react'
import type {
  BookmarkNode,
  ClosedEntrySummary,
  DownloadItem,
  MagicStackModuleId,
  PhoneBarPosition,
  Tab,
  UIState
} from '@shared/types'
import { getHost } from '@shared/url'
import { run } from '@renderer/lib/api'
import { fileGlyphFor, type FileGlyph } from '@renderer/lib/downloadsView'
import { useFaviconSrc } from '@renderer/lib/favicons'
import { collectCells, FlipTracker } from '@renderer/lib/motion/flip'
import { reducedMotion } from '@renderer/lib/motion/spring'
import { openPage } from '@renderer/lib/pages'
import { browserStore, showLocalMenu } from '@renderer/lib/ui'
import { cn, formatBytes, relativeTime } from '@renderer/lib/utils'
import { RowView, type RowContext } from '../pages/settings/rows'
import { PhoneSheet } from '../phone/PhoneSheet'
import {
  availableModules,
  magicStackModule,
  pageAt,
  planMagicStack,
  type MagicStackCard,
  type MagicStackSources
} from './magicStackPlan'
import {
  closeMagicStackCustomize,
  magicStackCustomizeStore,
  openMagicStackCustomize
} from './magicStackCustomize'

/**
 * The new tab page's Magic Stack (NTP-16; Chrome's `HomeModulesCoordinator`): a horizontally
 * paged strip of module cards under the shortcut tiles – the newest recently closed tab, the
 * last download, the newest bookmarks, the default-browser reminder – each on one card chassis
 * with a title row (the module's glyph, its name, the ⋮), its content and one action. The ⋮
 * offers Hide This and Customise; the Customise sheet lists the modules with switches. Hidden
 * modules are this device's (`UIState.newTabHiddenModules`, never synced); a stack with no card
 * to show is not drawn at all, as Chrome draws none.
 *
 * Design language v2: the page is a window surface, and each card is a page surface on it
 * (§9.29: the field and the sheets are page surfaces; the cards join them) – `--v2-card` under a
 * `--v2-card-border` hairline at the card radius, no shadow (§3). The ⋮ is the shared 44 icon
 * button (§9.3), the action a hugging secondary button (§9.11's in-row form). The strip snaps a
 * card at a time with the next one peeking, and the page dots under it name the page.
 *
 * Motion (§11.4): a hidden card leaves on a 120 ms fade as the cards after it close the gap on
 * the FLIP tracker's spring; under reduced motion the card is cut and the others take their
 * places on the tracker's own 120 ms fade (§11.3). The strip comes in on the tiles' fade, after
 * the last tile.
 */
export function MagicStack({
  state,
  tab,
  dock
}: {
  state: UIState
  tab: Tab
  dock: PhoneBarPosition
}): JSX.Element | null {
  const sources = useSources(state)
  const hidden = state.newTabHiddenModules
  // A module hidden from a card's menu is kept as hidden here until the core's list has it, so
  // the card cannot come back between the command and the state; once the list has an id, the
  // id is dropped in the render that sees it (the previous-render pattern, no effect needed).
  const [pendingHidden, setPendingHidden] = useState<MagicStackModuleId[]>([])
  const settled = pendingHidden.filter((id) => hidden.includes(id))
  if (settled.length > 0) setPendingHidden(pendingHidden.filter((id) => !hidden.includes(id)))
  // The card on its way out: hidden already, drawn once more for the fade.
  const [leaving, setLeaving] = useState<MagicStackModuleId | null>(null)
  const stripRef = useRef<HTMLUListElement>(null)
  const [page, setPage] = useState(0)
  useStackFlip(stripRef)

  // The fade's end takes the card out; a timer stands in for an `animationend` that never comes
  // (the page not painted, the animation cut by a stylesheet).
  useEffect(() => {
    if (!leaving) return
    const timer = window.setTimeout(() => setLeaving(null), LEAVE_MS + 80)
    return () => window.clearTimeout(timer)
  }, [leaving])

  const effectiveHidden = useMemo(() => {
    const all = new Set<MagicStackModuleId>([...hidden, ...pendingHidden])
    if (leaving) all.delete(leaving)
    return [...all]
  }, [hidden, pendingHidden, leaving])

  const cards = useMemo(() => planMagicStack(sources, effectiveHidden), [sources, effectiveHidden])

  if (cards.length === 0) return null

  const hide = (id: MagicStackModuleId): void => {
    setPendingHidden((p) => (p.includes(id) ? p : [...p, id]))
    if (!reducedMotion()) setLeaving(id)
    run('newtab.setModuleHidden', { id, hidden: true })
  }

  const openMenu = (id: MagicStackModuleId): void => {
    const module = magicStackModule(id)
    void showLocalMenu(
      'newtab',
      [
        { label: 'Hide This', onSelect: () => hide(id) },
        { label: 'Customise', onSelect: openMagicStackCustomize }
      ],
      tab.id,
      { title: module.title }
    )
  }

  const onScroll = (e: UIEvent<HTMLUListElement>): void => {
    const el = e.currentTarget
    const first = el.firstElementChild as HTMLElement | null
    if (!first) return
    const pitch = first.getBoundingClientRect().width + CARD_GAP
    setPage(pageAt(el.scrollLeft, pitch, el.children.length))
  }

  const goTo = (index: number): void => {
    const el = stripRef.current
    const target = el?.children[index] as HTMLElement | undefined
    if (!el || !target) return
    el.scrollTo({ left: target.offsetLeft, behavior: reducedMotion() ? 'auto' : 'smooth' })
  }

  const current = Math.min(page, cards.length - 1)

  return (
    <section
      className={cn('zen-mstack w-full max-w-[520px]', dock === 'bottom' ? 'mb-6' : 'mt-6')}
      aria-label="Magic Stack"
    >
      <ul
        ref={stripRef}
        className="zen-mstack-strip"
        role="list"
        aria-roledescription="carousel"
        onScroll={onScroll}
      >
        {cards.map((card) => (
          <li
            key={card.id}
            className="zen-mstack-card"
            data-surface="page"
            data-cell={card.id}
            data-leaving={leaving === card.id || undefined}
            aria-label={cardLabel(card)}
            onAnimationEnd={(e) => {
              if (e.target === e.currentTarget && leaving === card.id) setLeaving(null)
            }}
          >
            <CardBody card={card} tabId={tab.id} onMenu={() => openMenu(card.id)} />
          </li>
        ))}
      </ul>
      {cards.length > 1 && (
        // The pages, named and pickable (Chrome's strip announces its page the same way).
        <div className="zen-mstack-dots" role="tablist" aria-label="Magic Stack pages">
          {cards.map((card, index) => (
            <button
              key={card.id}
              type="button"
              role="tab"
              className="zen-mstack-dot"
              aria-selected={index === current}
              aria-label={`Page ${index + 1} of ${cards.length}: ${magicStackModule(card.id).title}`}
              onClick={() => goTo(index)}
            >
              <span aria-hidden />
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

/** The gap between two cards (the stylesheet's `.zen-mstack-strip` gap). */
const CARD_GAP = 8
/** The hidden card's fade (§11.4), the stylesheet's `zen-mstack-leave`. */
const LEAVE_MS = 120

const MODULE_GLYPHS: Record<MagicStackModuleId, LucideIcon> = {
  continue: History,
  downloads: Download,
  bookmarks: Bookmark,
  'default-browser': Globe
}

/** The desktop row's file-type glyphs (`fileGlyphFor`), as the Downloads sheet draws them. */
const FILE_GLYPHS: Record<FileGlyph, LucideIcon> = {
  text: FileText,
  image: Image,
  archive: FileArchive,
  video: FileVideo,
  audio: FileAudio,
  code: FileCode,
  package: Package,
  file: File
}

function useSources(state: UIState): MagicStackSources {
  const { recentlyClosed, downloads, bookmarks, defaultBrowser } = state
  const canRequestDefault = state.capabilities.defaultBrowser
  return useMemo(
    () => ({ recentlyClosed, downloads, bookmarks, defaultBrowser, canRequestDefault }),
    [recentlyClosed, downloads, bookmarks, defaultBrowser, canRequestDefault]
  )
}

/**
 * The strip's FLIP set (`lib/motion/flip.ts`): every card glides to its new slot on the one
 * spring when a card leaves. The positions are read against the strip itself, which is what
 * scrolls here; listening for as long as the strip is mounted, as the tile grid does.
 */
function useStackFlip(strip: RefObject<HTMLElement | null>): void {
  const tracker = useMemo(() => new FlipTracker(), [])
  useLayoutEffect(() => {
    tracker.commit(collectCells(strip.current), strip.current, true)
  })
  useEffect(() => {
    tracker.listen()
    return () => tracker.dispose()
  }, [tracker])
}

/** What TalkBack reads for the card: the module, then what it holds. */
function cardLabel(card: MagicStackCard): string {
  const title = magicStackModule(card.id).title
  switch (card.id) {
    case 'continue':
      return `${title}: ${closedTitle(card.entry)}`
    case 'downloads':
      return `${title}: ${card.item.finalName || card.item.filename}`
    case 'bookmarks':
      return `${title}: ${card.items.map((b) => b.title || getHost(b.url ?? '')).join(', ')}`
    case 'default-browser':
      return `${title}: set Zenium as your default browser`
  }
}

function closedTitle(entry: ClosedEntrySummary): string {
  if (entry.kind === 'window') return `Window with ${entry.tabCount} tabs`
  return entry.title || (entry.url ? getHost(entry.url) : 'Closed tab')
}

function CardBody({
  card,
  tabId,
  onMenu
}: {
  card: MagicStackCard
  tabId: string
  onMenu: () => void
}): JSX.Element {
  const module = magicStackModule(card.id)
  const Glyph = MODULE_GLYPHS[card.id]
  return (
    <>
      <div className="zen-mstack-head">
        <Glyph className="zen-mstack-glyph" aria-hidden />
        <h3 className="zen-mstack-title">{module.title}</h3>
        <button
          type="button"
          className="zen-v2-icon-button zen-mstack-more"
          aria-label={`More options for ${module.title}`}
          onClick={onMenu}
        >
          <EllipsisVertical />
        </button>
      </div>
      {card.id === 'continue' && <ContinueContent entry={card.entry} />}
      {card.id === 'downloads' && <DownloadContent item={card.item} />}
      {card.id === 'bookmarks' && <BookmarksContent items={card.items} tabId={tabId} />}
      {card.id === 'default-browser' && <DefaultBrowserContent />}
      <div className="zen-mstack-actions">
        {card.id === 'continue' && (
          <Action onClick={() => run('session.restoreClosed', { id: card.entry.id })}>
            Reopen
          </Action>
        )}
        {card.id === 'downloads' && (
          <>
            <Action onClick={() => run('download.open', { id: card.item.id })}>Open</Action>
            <Action onClick={() => openPage('downloads')}>See all</Action>
          </>
        )}
        {card.id === 'bookmarks' && <Action onClick={() => openPage('bookmarks')}>See all</Action>}
        {card.id === 'default-browser' && (
          <Action primary onClick={() => run('defaultBrowser.request', { source: 'banner' })}>
            Set as default
          </Action>
        )}
      </div>
    </>
  )
}

function Action({
  children,
  primary,
  onClick
}: {
  children: ReactNode
  primary?: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      className="zen-v2-button zen-mstack-action"
      data-primary={primary || undefined}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

/**
 * One line of content (§9.2's two-line row): a 20 glyph or favicon, the name at 15, the detail
 * at 13 in the deemphasised ink. As a button it opens what it names.
 */
function ContentRow({
  glyph,
  title,
  detail,
  onClick,
  label
}: {
  glyph: ReactNode
  title: string
  detail?: string
  onClick?: () => void
  label?: string
}): JSX.Element {
  const inner = (
    <>
      <span className="zen-mstack-row-glyph" aria-hidden>
        {glyph}
      </span>
      <span className="zen-mstack-row-text">
        <span className="zen-mstack-row-title">{title}</span>
        {detail && <span className="zen-mstack-row-detail">{detail}</span>}
      </span>
    </>
  )
  if (!onClick) return <div className="zen-mstack-row">{inner}</div>
  return (
    <button
      type="button"
      className="zen-v2-row zen-mstack-row"
      aria-label={label}
      onClick={onClick}
    >
      {inner}
    </button>
  )
}

function Favicon({
  favicon,
  url
}: {
  favicon: string | null | undefined
  url: string | null
}): JSX.Element {
  const src = useFaviconSrc(favicon, url)
  if (!src) return <Globe />
  return <img src={src} alt="" className="zen-mstack-favicon" />
}

function ContinueContent({ entry }: { entry: ClosedEntrySummary }): JSX.Element {
  const detail =
    entry.kind === 'window'
      ? `Closed ${relativeTime(entry.closedAt).toLowerCase()}`
      : entry.url
        ? getHost(entry.url)
        : undefined
  return (
    <ContentRow
      glyph={<Favicon favicon={entry.favicon} url={entry.url} />}
      title={closedTitle(entry)}
      detail={detail}
      label={`Reopen ${closedTitle(entry)}`}
      onClick={() => run('session.restoreClosed', { id: entry.id })}
    />
  )
}

function DownloadContent({ item }: { item: DownloadItem }): JSX.Element {
  const name = item.finalName || item.filename
  const Glyph = FILE_GLYPHS[fileGlyphFor(name, item.mimeType)]
  const when = item.completedAt ?? item.endedAt
  const detail = [
    formatBytes(item.totalBytes || item.receivedBytes),
    when ? relativeTime(when) : null
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <ContentRow
      glyph={<Glyph />}
      title={name}
      detail={detail}
      label={`Open ${name}`}
      onClick={() => run('download.open', { id: item.id })}
    />
  )
}

function BookmarksContent({ items, tabId }: { items: BookmarkNode[]; tabId: string }): JSX.Element {
  return (
    <div className="zen-mstack-list">
      {items.map((b) => (
        <BookmarkRow key={b.id} node={b} tabId={tabId} />
      ))}
    </div>
  )
}

function BookmarkRow({ node, tabId }: { node: BookmarkNode; tabId: string }): JSX.Element {
  const url = node.url ?? ''
  const title = node.title || getHost(url)
  return (
    <ContentRow
      glyph={<Favicon favicon={node.favicon} url={url} />}
      title={title}
      detail={getHost(url)}
      label={`Open ${title}`}
      onClick={() => run('bookmark.open', { id: node.id, newTab: false, tabId })}
    />
  )
}

function DefaultBrowserContent(): JSX.Element {
  return (
    <p className="zen-mstack-text">
      Open links from other apps in Zenium, with your bookmarks, passwords and tabs along.
    </p>
  )
}

// ---------------------------------------------------------------------------
// The Customise sheet: the modules as switch rows.
// ---------------------------------------------------------------------------

/** The Settings rows' context: a switch row never asks the page for a sheet, so nothing to open. */
const NO_SHEETS: RowContext = { open: () => {} }

/**
 * Mounted once at the root, as the page's customise sheet is: while the store says open, the
 * sheet renders in the frame's dialog host (`PhoneSheet` places itself there) over the content
 * frame, which recedes under it.
 */
export function MagicStackCustomizeLayer(): JSX.Element | null {
  const open = magicStackCustomizeStore.use((s) => s.open)
  const state = browserStore.use((s) => s.state)
  if (!open || !state) return null
  return <MagicStackCustomizeSheet state={state} />
}

/**
 * Chrome's "Customise Magic Stack": every module this host has as a switch row (§10.4, the
 * shared `RowView`), its description under the name; a switch writes the device's hidden set
 * at once, so the page behind the sheet shows the card come or go as the sheet is used.
 */
function MagicStackCustomizeSheet({ state }: { state: UIState }): JSX.Element {
  const hidden = state.newTabHiddenModules
  const modules = availableModules({ canRequestDefault: state.capabilities.defaultBrowser })
  return (
    <PhoneSheet
      name="newtab-magic-stack-customize"
      title={{ pose: 'header', text: 'Magic Stack' }}
      onClose={closeMagicStackCustomize}
    >
      <div className="zen-ntp-customize flex flex-col pb-1">
        <section className="zen-v2-section flex flex-col">
          <h3 className="zen-v2-heading">Show</h3>
          {modules.map((m) => (
            <RowView
              key={m.id}
              ctx={NO_SHEETS}
              row={{
                id: m.id,
                kind: 'switch',
                label: m.title,
                description: m.description,
                checked: !hidden.includes(m.id),
                onChange: (checked) => run('newtab.setModuleHidden', { id: m.id, hidden: !checked })
              }}
            />
          ))}
          <p className="zen-v2-description px-4 pt-3">
            A card appears only when it has something to show.
          </p>
        </section>
      </div>
    </PhoneSheet>
  )
}
