import type { JSX } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Download } from 'lucide-react'
import type { DownloadItem, UIState } from '@shared/types'
import { downloadStatus, displayNameOf, engineFieldsOf, isActiveDownload, needsDangerDecision } from '@shared/downloads'
import { run } from '@renderer/lib/api'
import {
  DOWNLOAD_LINGER_MS,
  bubbleItems,
  closeDownloadBubble,
  dismissDownloadBubble,
  downloadsUi
} from '@renderer/lib/downloads'
import { activeTab } from '@renderer/lib/selectors'
import { browserStore, openOverlay } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { DangerPills, DownloadActions, DownloadProgressBar, FileTypeGlyph } from './DownloadParts'

const WIDTH = 360
/** Rows shown before the list scrolls. */
const VISIBLE_ROWS = 6
const ROW_HEIGHT = 60

/**
 * The downloads bubble (Chrome 112+): a panel anchored under the toolbar button with the
 * current list, or only the items that just finished when it opened by itself. Mounted once
 * above whichever shell is up; the live page behind shows its snapshot while the bubble is up.
 */
export function DownloadBubbleLayer(): JSX.Element | null {
  const open = downloadsUi.use((s) => s.open)
  const state = browserStore.use((s) => s.state)
  if (!open || !state) return null
  return <Bubble state={state} />
}

function Bubble({ state }: { state: UIState }): JSX.Element {
  const ui = downloadsUi.use()
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: 8, top: 8 })
  const [held, setHeld] = useState(false)
  const width = Math.min(WIDTH, window.innerWidth - 16)
  const items = bubbleItems(state.downloads, ui.partial)

  // 8px below the button, its centre inside the panel's first 40px; clamped to the window.
  useLayoutEffect(() => {
    const el = panelRef.current
    if (!el) return
    const anchor = document.querySelector<HTMLElement>('[data-zen-downloads-button]')
    const rect = el.getBoundingClientRect()
    const a = anchor?.getBoundingClientRect()
    const x = a ? a.left + a.width / 2 - 20 : window.innerWidth - width - 8
    const y = a ? a.bottom + 8 : 48
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))
    })
    if (!ui.autoClose) el.focus({ preventScroll: true })
  }, [width, ui.autoClose, items.length])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      closeDownloadBubble()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // The auto-opened bubble leaves after five idle seconds; a pointer or focus on it holds it.
  useEffect(() => {
    if (!ui.autoClose || held) return
    const timer = setTimeout(() => closeDownloadBubble(), DOWNLOAD_LINGER_MS)
    return () => clearTimeout(timer)
  }, [ui.autoClose, held])

  const showAll = (): void => {
    dismissDownloadBubble()
    void openOverlay('downloads', activeTab(state)?.id ?? null)
  }

  return (
    <div className="fixed inset-0 z-[80]" onMouseDown={() => closeDownloadBubble()}>
      <div
        ref={panelRef}
        role="dialog"
        aria-label="Downloads"
        tabIndex={-1}
        className={cn(
          'zen-panel zen-download-bubble absolute flex flex-col p-3 outline-none',
          ui.closing ? 'zen-animate-pop-out' : 'zen-animate-pop'
        )}
        style={{ left: pos.left, top: pos.top, width }}
        onMouseDown={(e) => e.stopPropagation()}
        onMouseEnter={() => setHeld(true)}
        onMouseLeave={() => setHeld(false)}
        onFocus={() => setHeld(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHeld(false)
        }}
      >
        <header className="flex h-8 shrink-0 items-center gap-2 pl-1">
          <h2 className="flex-1 text-[15px] font-semibold tracking-[-0.012em]">Downloads</h2>
          <button type="button" className="zen-download-pill" onClick={showAll}>
            Show all
          </button>
        </header>
        {items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 pb-6 pt-5 text-center">
            <Download className="h-6 w-6 text-[var(--zen-faint)]" strokeWidth={1.5} aria-hidden />
            <p className="text-[13px] text-[var(--zen-muted)]">Files you download appear here</p>
          </div>
        ) : (
          <ul
            className="zen-download-list -mx-1 mt-1 overflow-y-auto px-1"
            style={{ maxHeight: VISIBLE_ROWS * ROW_HEIGHT + 8 }}
          >
            {items.map((item) => (
              <BubbleRow
                key={item.id}
                item={item}
                highlighted={item.id === ui.highlightId}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function BubbleRow({
  item,
  highlighted
}: {
  item: DownloadItem
  highlighted: boolean
}): JSX.Element {
  const ref = useRef<HTMLLIElement>(null)
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [highlighted])
  const status = downloadStatus(item)
  const active = isActiveDownload(item)
  const extra = engineFieldsOf(item)
  const openable =
    item.state === 'completed' && extra.removed !== true && !needsDangerDecision(item)
  const dangerous = needsDangerDecision(item)
  return (
    <li
      ref={ref}
      className={cn(
        'zen-download-row group/row relative flex h-[60px] items-center gap-3 rounded-[6px] px-2',
        openable && 'cursor-default',
        highlighted && 'zen-download-row-marked'
      )}
      data-state={item.state}
      onClick={() => openable && run('download.open', { id: item.id })}
      onKeyDown={(e) => {
        if (openable && (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
          e.preventDefault()
          run('download.open', { id: item.id })
        }
      }}
      tabIndex={0}
      role={openable ? 'button' : undefined}
      aria-label={`${item.filename}. ${status.text}`}
    >
      <FileTypeGlyph item={item} />
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            'truncate text-[13px] font-medium leading-[1.25]',
            (item.state === 'cancelled' || extra.removed) &&
              'text-[var(--zen-muted)]'
          )}
          title={item.savePath || item.url}
        >
          {displayNameOf(item)}
        </div>
        <div
          className={cn(
            'mt-0.5 truncate text-[12.5px] leading-[1.25] tabular-nums',
            status.tone === 'warn'
              ? 'text-[var(--zen-warn)]'
              : status.tone === 'danger'
                ? 'text-[var(--zen-danger)]'
                : 'text-[var(--zen-muted)]'
          )}
        >
          {status.text}
        </div>
        {active && (
          <div className="mt-1.5">
            <DownloadProgressBar item={item} />
          </div>
        )}
      </div>
      {dangerous ? (
        <DangerPills item={item} />
      ) : (
        <div className="zen-download-actions flex shrink-0 items-center gap-0.5">
          <DownloadActions item={item} retry={false} />
        </div>
      )}
    </li>
  )
}
