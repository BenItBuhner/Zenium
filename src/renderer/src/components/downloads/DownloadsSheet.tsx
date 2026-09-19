import type { JSX, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import {
  FileDown,
  FolderOpen,
  Pause,
  Play,
  RotateCw,
  Settings2,
  ShieldAlert,
  Trash2,
  TriangleAlert,
  X
} from 'lucide-react'
import type { DownloadItem, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { useBackSurface } from '@renderer/lib/back'
import { canRetry, downloadStatus, isQuarantined } from '@renderer/lib/downloadText'
import { closeOverlay, uiStore } from '@renderer/lib/ui'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'

/** Row and button glyphs on a phone are 20 px at stroke 1.75 (design language v2 §9.3). */
const STROKE = 1.75

/** The `download.*` commands a row issues; every one takes the row's id. */
type RowCommand =
  | 'download.pause'
  | 'download.resume'
  | 'download.cancel'
  | 'download.retry'
  | 'download.open'
  | 'download.showInFolder'
  | 'download.remove'
  | 'download.acceptDanger'
  | 'download.discard'

/**
 * The Android downloads surface: Chrome's download list in the phone sheet chassis (v2 §6,
 * §9.16). Newest first; a running row shows its progress, speed and time left with Pause and
 * Cancel, a paused or interrupted one Resume, a failed one Retry; a finished row opens on tap
 * and can be shown in the system Downloads app or taken off the list; a flagged file waits
 * behind its warning with Discard and Keep. The header's trailing control opens Settings >
 * Downloads; an action row under the list, past a hairline, clears the finished rows.
 */
export function DownloadsSheet({ state }: { state: UIState }): JSX.Element {
  const items = state.downloads
  const sheet = useRef<BottomSheetHandle>(null)
  /** The sheet is sliding away to hand over to another overlay: leave the overlay stack to it. */
  const handoff = useRef(false)

  // The system back gesture pulls the sheet down with the finger; the back button, a hardware
  // Escape and a scrim tap slide it away.
  useBackSurface({
    name: 'downloads',
    onProgress: (progress) => sheet.current?.backProgress(progress),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  useEscape(() => sheet.current?.dismiss())

  // "2 min ago" moves while the sheet is up.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  const finished = items.some((item) => !inFlight(item))
  // Rows coming and going (or growing a Keep / Discard row, or the Clear list row appearing)
  // re-measure the detents; a progress tick does not, since a re-measure also scrolls the list
  // back to its top.
  const contentKey =
    (items.map((item) => `${item.id}${isQuarantined(item) ? '!' : ''}`).join(',') || 'empty') +
    (finished ? '+clear' : '')

  const openSettings = (): void => {
    handoff.current = true
    sheet.current?.dismiss(() =>
      uiStore.set({
        overlay: 'settings',
        overlaySection: 'downloads',
        overlaySpaceId: null,
        overlayFolderId: null
      })
    )
  }

  return (
    <BottomSheet
      ref={sheet}
      onDismissed={() => {
        if (!handoff.current) closeOverlay()
      }}
      contentKey={contentKey}
      className="zen-v2-sheet"
      handleLabel="Resize downloads"
      header={
        <>
          <h2 className="zen-sheet-title">Downloads</h2>
          <button
            type="button"
            className="zen-sheet-header-control"
            data-side="trailing"
            aria-label="Downloads settings"
            title="Downloads settings"
            onClick={openSettings}
          >
            <Settings2 className="h-5 w-5" strokeWidth={STROKE} />
          </button>
        </>
      }
    >
      {items.length === 0 ? (
        <p className="zen-v2-empty">Files you download will appear here</p>
      ) : (
        <ul className="pb-2">
          {items.map((item) => (
            <DownloadRow key={item.id} item={item} now={now} />
          ))}
          {finished && (
            <>
              <li aria-hidden className="zen-sheet-sep" />
              <li>
                <button
                  type="button"
                  className="zen-v2-row zen-v2-row-action"
                  onClick={() => run('download.removeCompleted', undefined)}
                >
                  Clear list
                </button>
              </li>
            </>
          )}
        </ul>
      )}
    </BottomSheet>
  )
}

function inFlight(item: DownloadItem): boolean {
  return item.state === 'progressing' || item.state === 'paused'
}

function DownloadRow({ item, now }: { item: DownloadItem; now: number }): JSX.Element {
  const running = item.state === 'progressing'
  const paused = item.state === 'paused'
  const quarantined = isQuarantined(item)
  const resumable = item.state === 'interrupted' && item.canResume
  const retry = !resumable && canRetry(item)
  const openable = item.state === 'completed' && !quarantined
  const fraction = item.totalBytes > 0 ? Math.min(1, item.receivedBytes / item.totalBytes) : null
  const act = (name: RowCommand) => (): void => run(name, { id: item.id })
  const Glyph = quarantined
    ? item.danger.level === 'dangerous'
      ? ShieldAlert
      : TriangleAlert
    : FileDown
  return (
    <li className="zen-v2-row zen-v2-row-two-line">
      <Glyph
        className="zen-v2-row-glyph"
        strokeWidth={STROKE}
        data-level={quarantined ? item.danger.level : undefined}
      />
      <div className="zen-v2-row-text">
        <Body onTap={openable ? act('download.open') : null} label={`Open ${item.finalName}`}>
          <span className="flex min-w-0 items-center gap-2">
            <span className="zen-v2-row-label" title={item.savePath || item.url}>
              {item.finalName}
            </span>
            {item.private && <span className="zen-v2-badge">Private</span>}
          </span>
          {quarantined ? (
            <span className="zen-v2-warning" data-level={item.danger.level}>
              {item.danger.message}
            </span>
          ) : (
            <span className="zen-v2-row-description">{downloadStatus(item, now)}</span>
          )}
          {inFlight(item) && (
            <span
              className="zen-v2-progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}
              data-paused={paused || undefined}
              data-indeterminate={(fraction === null && running) || undefined}
            >
              <span
                className="zen-v2-progress-bar"
                style={fraction === null ? undefined : { transform: `scaleX(${fraction})` }}
              />
            </span>
          )}
        </Body>
        {quarantined && (
          <div className="zen-v2-row-buttons">
            <button
              type="button"
              className="zen-v2-button"
              data-danger="true"
              onClick={act('download.discard')}
            >
              Discard
            </button>
            <button type="button" className="zen-v2-button" onClick={act('download.acceptDanger')}>
              Keep
            </button>
          </div>
        )}
      </div>
      <div className="zen-v2-row-actions">
        {running && (
          <IconButton label="Pause" onClick={act('download.pause')}>
            <Pause strokeWidth={STROKE} />
          </IconButton>
        )}
        {(paused || resumable) && (
          <IconButton label="Resume" onClick={act('download.resume')}>
            <Play strokeWidth={STROKE} />
          </IconButton>
        )}
        {retry && (
          <IconButton label="Retry" onClick={act('download.retry')}>
            <RotateCw strokeWidth={STROKE} />
          </IconButton>
        )}
        {inFlight(item) ? (
          <IconButton label="Cancel" onClick={act('download.cancel')}>
            <X strokeWidth={STROKE} />
          </IconButton>
        ) : (
          <>
            {openable && (
              <IconButton label="Show in the Downloads app" onClick={act('download.showInFolder')}>
                <FolderOpen strokeWidth={STROKE} />
              </IconButton>
            )}
            {!quarantined && (
              <IconButton label="Remove from list" onClick={act('download.remove')}>
                <Trash2 strokeWidth={STROKE} />
              </IconButton>
            )}
          </>
        )}
      </div>
    </li>
  )
}

/** The row's text block: a button while the file can be opened, plain text otherwise. */
function Body({
  onTap,
  label,
  children
}: {
  onTap: (() => void) | null
  label: string
  children: ReactNode
}): JSX.Element {
  if (!onTap) return <div className="zen-v2-row-body">{children}</div>
  return (
    <button type="button" className="zen-v2-row-body" aria-label={label} onClick={onTap}>
      {children}
    </button>
  )
}

function IconButton({
  label,
  onClick,
  children
}: {
  label: string
  onClick: () => void
  children: ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      className="zen-v2-icon-button"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

/** Escape closes the sheet (hardware keyboards exist on tablets and DeX too). */
function useEscape(close: () => void): void {
  const latest = useRef(close)
  useEffect(() => {
    latest.current = close
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        latest.current()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}
