import type { JSX } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Download } from 'lucide-react'
import type { DownloadItem, UIState } from '@shared/types'
import { displayName, isActiveDownload } from '@shared/downloadsShell'
import {
  DOWNLOAD_LINGER_MS,
  bubbleItems,
  closeDownloadBubble,
  downloadsUi,
  showAllDownloads
} from '@renderer/lib/downloads'
import { downloadsEngine, showsDangerDecision } from '@renderer/lib/downloadsEngine'
import { isOnDisk } from '@renderer/lib/downloadsView'
import { browserStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import {
  DangerActions,
  DlButton,
  DownloadActions,
  DownloadProgressBar,
  FileTypeGlyph,
  StatusLine
} from './DownloadParts'

const WIDTH = 360
/** Rows shown before the list scrolls. */
const VISIBLE_ROWS = 6
const ROW_HEIGHT = 52

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
  const items = bubbleItems(downloadsEngine.list(state), ui.partial)

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

  return (
    <div className="fixed inset-0 z-[80]" onMouseDown={() => closeDownloadBubble()}>
      <div
        ref={panelRef}
        role="dialog"
        aria-label="Downloads"
        data-zen-downloads-bubble
        tabIndex={-1}
        className={cn(
          'zen-dl-surface zen-dl-bubble absolute flex flex-col outline-none',
          ui.closing ? 'zen-dl-pop-out' : 'zen-dl-pop'
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
        <header className="flex shrink-0 items-center px-4 pb-2 pt-3">
          <h2 className="flex-1 text-[17px] font-semibold leading-6">Downloads</h2>
        </header>
        {items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 pb-6 pt-4 text-center">
            <Download className="zen-dl-deemph h-4 w-4" strokeWidth={1.5} aria-hidden />
            <p className="zen-dl-deemph text-[15px] leading-5">Files you download appear here</p>
          </div>
        ) : (
          <ul
            className="zen-dl-list overflow-y-auto px-2"
            style={{ maxHeight: VISIBLE_ROWS * ROW_HEIGHT + 8 }}
          >
            {items.map((item) => (
              <BubbleRow key={item.id} item={item} highlighted={item.id === ui.highlightId} />
            ))}
          </ul>
        )}
        <footer className="flex shrink-0 items-center justify-end px-3 pb-3 pt-2">
          <DlButton onClick={() => showAllDownloads(state)}>Show all</DlButton>
        </footer>
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
  const active = isActiveDownload(item)
  const openable = isOnDisk(item)
  const name = displayName(item)
  const open = (): void => {
    if (openable) downloadsEngine.open(item.id)
  }
  return (
    <li
      ref={ref}
      className={cn(
        'zen-dl-row group/row relative flex min-h-[52px] items-start gap-3 px-2 py-[6px]',
        highlighted && 'zen-dl-row-marked'
      )}
      data-state={item.state}
      data-download-id={item.id}
      onDoubleClick={open}
      onKeyDown={(e) => {
        if (openable && e.key === 'Enter' && e.target === e.currentTarget) {
          e.preventDefault()
          open()
        }
      }}
      tabIndex={0}
      aria-label={`${name}. ${item.state}`}
    >
      <FileTypeGlyph item={item} />
      <div className="min-w-0 flex-1">
        {openable ? (
          <button
            type="button"
            className="zen-dl-name block max-w-full truncate text-left text-[15px] leading-5"
            title={item.savePath || item.url}
            onClick={open}
          >
            {name}
          </button>
        ) : (
          <div
            className={cn(
              'zen-dl-name truncate text-[15px] leading-5',
              item.state === 'cancelled' && 'zen-dl-deemph'
            )}
            title={item.savePath || item.url}
          >
            {name}
          </div>
        )}
        <StatusLine item={item} />
        {active && (
          <div className="mt-1.5 pb-0.5">
            <DownloadProgressBar item={item} />
          </div>
        )}
      </div>
      {showsDangerDecision(item) ? (
        <DangerActions item={item} />
      ) : (
        <div className="zen-dl-actions -mr-1 flex shrink-0 items-center">
          <DownloadActions item={item} />
        </div>
      )}
    </li>
  )
}
