import type { JSX, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import {
  ExternalLink,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileText,
  FileVideo,
  FileX,
  FolderOpen,
  Image,
  Package,
  Pause,
  Play,
  RotateCw,
  Trash2,
  X,
  type LucideIcon
} from 'lucide-react'
import type { DownloadDeleteFileResult, DownloadItem } from '@shared/types'
import {
  canResumeDownload,
  canRetryDownload,
  deleteFileToast,
  displayName,
  isActiveDownload
} from '@shared/downloadsShell'
import { downloadsEngine, showsDangerDecision } from '@renderer/lib/downloadsEngine'
import {
  dangerActionLabels,
  downloadStatus,
  fileGlyphFor,
  isDeletedRow,
  isOnDisk,
  splitFileName,
  type FileGlyph
} from '@renderer/lib/downloadsView'
import { pushToast } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'

/*
 * Pieces a download row is made of, shared by the bubble and the `zen://downloads` page tab
 * (`pages/downloads/DownloadsPage.tsx`): the bubble's row itself (design language v2 §9.2
 * two-line row with §9.18 centred trailing controls), the file-type glyph, the middle-truncated
 * name, the status line, the thin progress bar, the row's icon action, the hover actions and
 * the Keep / Delete pair for flagged files, all on the engine's commands (PR #69, #166 for
 * Delete file and the file-missing signal behind the Deleted row).
 */

const GLYPHS: Record<FileGlyph, LucideIcon> = {
  text: FileText,
  image: Image,
  archive: FileArchive,
  video: FileVideo,
  audio: FileAudio,
  code: FileCode,
  package: Package,
  file: File
}

/** How long a Keep / Delete button spins before it gives up on a reply that never came. */
const BUSY_TIMEOUT_MS = 8000

/** The 16px file-type glyph, dimmed for records whose file is gone (cancelled, failed, deleted). */
export function FileTypeGlyph({ item }: { item: DownloadItem }): JSX.Element {
  const Icon = GLYPHS[fileGlyphFor(item.finalName || item.filename, item.mimeType)]
  const gone = item.state === 'cancelled' || item.state === 'interrupted' || isDeletedRow(item)
  return (
    <span className={cn('zen-dl-glyph', gone && 'opacity-40')} aria-hidden>
      <Icon className="h-4 w-4" strokeWidth={1.5} />
    </span>
  )
}

/**
 * The file name, truncated in its middle when it does not fit: the head may lose its end to
 * an ellipsis, the tail – the extension and the end of the stem – always shows.
 */
export function FileName({
  name,
  title,
  dim,
  onOpen
}: {
  name: string
  title?: string
  /** A record without a file (cancelled, or deleted since): the name in the deemphasised ink. */
  dim?: boolean
  /** The file can be opened: the name is a button that does (the click handed over, for its keys). */
  onOpen?: (e: ReactMouseEvent<HTMLButtonElement>) => void
}): JSX.Element {
  const { head, tail } = splitFileName(name)
  const parts = (
    <>
      <span className="zen-dl-name-head">{head}</span>
      {tail && <span className="zen-dl-name-tail">{tail}</span>}
    </>
  )
  if (onOpen) {
    return (
      <button
        type="button"
        className="zen-dl-name zen-dl-name-open"
        title={title}
        onClick={(e) => {
          e.stopPropagation()
          onOpen(e)
        }}
      >
        {parts}
      </button>
    )
  }
  return (
    <span className={cn('zen-dl-name', dim && 'zen-dl-deemph')} title={title}>
      {parts}
    </span>
  )
}

/**
 * The status's words, set in the tone the status asks for (the deemphasised ink of the line
 * around them, the warning or the danger colour); a failure's carry the engine's sentence as
 * their tooltip. Nothing while the status has no words.
 */
export function StatusText({ item }: { item: DownloadItem }): JSX.Element | null {
  const status = downloadStatus(item)
  if (!status.text) return null
  return (
    <span
      className={cn(
        status.tone === 'warn' && 'zen-dl-status-warn',
        status.tone === 'danger' && 'zen-dl-status-danger'
      )}
      title={status.hint}
    >
      {status.text}
    </span>
  )
}

/** The one-line status under the name. */
export function StatusLine({ item }: { item: DownloadItem }): JSX.Element {
  return (
    <div className="zen-dl-status truncate tabular-nums">
      <StatusText item={item} />
    </div>
  )
}

/** The 3px bar: the fill scales from the left; unknown totals sweep. */
export function DownloadProgressBar({ item }: { item: DownloadItem }): JSX.Element {
  const known = item.totalBytes > 0
  const value = known ? Math.min(1, item.receivedBytes / item.totalBytes) : 0
  return (
    <div
      className="zen-dl-bar"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={known ? Math.round(value * 100) : undefined}
      data-paused={item.state === 'paused' || undefined}
    >
      <div
        className={cn('zen-dl-bar-fill', !known && 'zen-dl-bar-sweep')}
        style={known ? { transform: `scaleX(${value})` } : undefined}
      />
    </div>
  )
}

/**
 * A 32-tall text button of the downloads surfaces on the chassis `zen-button` (secondary by
 * default). Disabled is the whole control at .4; busy keeps full opacity, swaps the label for a
 * 16px spinner at the same width and says `aria-busy` (§9.30).
 */
export function DlButton({
  children,
  onClick,
  tone = 'secondary',
  title,
  disabled,
  busy,
  className,
  ...rest
}: {
  children: ReactNode
  onClick: () => void
  tone?: 'secondary' | 'primary' | 'danger'
  title?: string
  disabled?: boolean
  busy?: boolean
  className?: string
  'data-zen-dl-action'?: string
}): JSX.Element {
  return (
    <button
      type="button"
      className={cn('zen-button', busy && 'zen-dl-busy', className)}
      data-variant={tone === 'secondary' ? undefined : tone}
      title={title}
      disabled={disabled}
      aria-busy={busy || undefined}
      onClick={(e) => {
        e.stopPropagation()
        if (!busy) onClick()
      }}
      {...rest}
    >
      <span className="zen-dl-button-label">{children}</span>
      {busy && <span className="zen-dl-spinner" aria-hidden />}
    </button>
  )
}

/**
 * A row's icon button: the shared `.zen-v2-icon-button` (§9.34), which sizes the box and the
 * glyph from the density tokens. Disabled is the whole control at .4; busy keeps full opacity,
 * swaps the glyph for the 16px spinner and says `aria-busy` (§9.30), and ignores presses
 * meanwhile. `onClick` gets the press, for a menu button that anchors its menu on itself.
 */
export function IconAction({
  title,
  icon: Icon,
  onClick,
  pressed,
  disabled,
  busy,
  action,
  className,
  menu = false
}: {
  title: string
  icon: LucideIcon
  onClick: (e: ReactMouseEvent<HTMLButtonElement>) => void
  /** A toggle: rendered pressed while on. */
  pressed?: boolean
  disabled?: boolean
  busy?: boolean
  /** Names the control for tests and the harness (`data-zen-dl-action`). */
  action?: string
  className?: string
  /** The button opens a menu (`aria-haspopup`). */
  menu?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      className={cn(
        'zen-v2-icon-button',
        pressed && 'zen-dl-action-on',
        busy && 'zen-dl-busy',
        className
      )}
      title={title}
      aria-label={title}
      aria-pressed={pressed}
      aria-busy={busy || undefined}
      aria-haspopup={menu ? 'menu' : undefined}
      disabled={disabled}
      data-zen-dl-action={action}
      onClick={(e) => {
        e.stopPropagation()
        if (!busy) onClick(e)
      }}
    >
      <Icon aria-hidden />
      {busy && <span className="zen-dl-spinner" aria-hidden />}
    </button>
  )
}

/**
 * The row's controls for its state: Pause / Resume, Cancel and "Open when done" while in
 * flight, Resume for an interrupted transfer the server lets continue and Retry for the
 * cancelled ones and the failed ones whose reason a retry can get past (and for a Deleted row),
 * Show in folder and Delete file when the file exists, and Remove from list for anything
 * settled. Delete file spins until the engine answers; the row then reads Deleted (`deleted`,
 * or `missing` when the file was gone already), or a toast says the file would not go.
 */
export function DownloadActions({ item }: { item: DownloadItem }): JSX.Element {
  const id = item.id
  const e = downloadsEngine
  const inFlight = item.state === 'progressing' || item.state === 'paused'
  const resumable = canResumeDownload(item)
  const [deleting, setDeleting] = useState(false)
  const deleteFile = async (): Promise<void> => {
    setDeleting(true)
    let result: DownloadDeleteFileResult = 'failed'
    try {
      result = await e.deleteFile(id)
    } catch {
      // The command never came back: the file is where it was, as far as the row can tell.
    } finally {
      setDeleting(false)
    }
    const toast = deleteFileToast(result, displayName(item))
    if (toast) pushToast(toast, 'error')
  }
  return (
    <>
      {item.state === 'progressing' && (
        <IconAction title="Pause" icon={Pause} onClick={() => e.pause(id)} />
      )}
      {resumable && <IconAction title="Resume" icon={Play} onClick={() => e.resume(id)} />}
      {!resumable && canRetryDownload(item) && (
        <IconAction title="Retry" icon={RotateCw} action="retry" onClick={() => e.retry(id)} />
      )}
      {inFlight && (
        <IconAction
          title={item.openWhenDone ? 'Do not open when done' : 'Open when done'}
          icon={ExternalLink}
          pressed={item.openWhenDone}
          onClick={() => e.setOpenWhenDone(id, !item.openWhenDone)}
        />
      )}
      {inFlight && <IconAction title="Cancel" icon={X} onClick={() => e.cancel(id)} />}
      {isOnDisk(item) && (
        <IconAction
          title="Show in folder"
          icon={FolderOpen}
          action="show-in-folder"
          onClick={() => e.showInFolder(id)}
        />
      )}
      {isOnDisk(item) && (
        <IconAction
          title="Delete file"
          icon={FileX}
          action="delete-file"
          busy={deleting}
          onClick={() => void deleteFile()}
        />
      )}
      {!inFlight && (
        <IconAction
          title="Remove from list"
          icon={Trash2}
          action="remove"
          onClick={() => e.remove(id)}
        />
      )}
    </>
  )
}

/**
 * Keep / Delete for a file the engine flagged, worded as Chrome's bubble words them and weighted
 * as §6 has it on every tier (`dangerActionLabels`): Delete, the protective verb, the filled
 * primary; Keep the plain secondary; neither in the danger ink. The pressed one spins until the
 * engine answers – the row leaves the danger state or goes – and the other waits disabled
 * meanwhile.
 */
export function DangerActions({ item }: { item: DownloadItem }): JSX.Element {
  const labels = dangerActionLabels()
  const [busy, setBusy] = useState<'keep' | 'discard' | null>(null)
  useEffect(() => {
    if (!busy) return
    const timer = setTimeout(() => setBusy(null), BUSY_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [busy])
  const decide = (which: 'keep' | 'discard'): void => {
    setBusy(which)
    if (which === 'keep') downloadsEngine.acceptDanger(item.id)
    else downloadsEngine.discard(item.id)
  }
  return (
    <div className="zen-dl-decision">
      <DlButton
        tone={labels.prominent === 'keep' ? 'primary' : 'secondary'}
        busy={busy === 'keep'}
        disabled={busy === 'discard'}
        data-zen-dl-action="keep"
        onClick={() => decide('keep')}
      >
        {labels.keep}
      </DlButton>
      <DlButton
        tone={labels.prominent === 'discard' ? 'primary' : 'secondary'}
        busy={busy === 'discard'}
        disabled={busy === 'keep'}
        data-zen-dl-action="discard"
        onClick={() => decide('discard')}
      >
        {labels.discard}
      </DlButton>
    </div>
  )
}

/**
 * One download in the bubble's list: the shared `.zen-v2-row` (§9.34) as a §9.2 two-line row
 * (name over status, 52 tall, growing around a progress bar or a warning's sentence) with the
 * glyph on the first line and the controls centred on the row's height (§9.18); rows touch
 * (§9.21), and what a download row adds is the `.zen-dl-row` modifier. Enter or a double click
 * opens a finished file, the name is a button that opens it, a right click or the menu key asks
 * the core for the row's menu, and on desktop hosts a finished file can be dragged out to the
 * OS. A finished file the engine found gone from disk is Chrome's Deleted row: name and glyph
 * in the deemphasised ink, status "Deleted", nothing to open, show or drag, Retry and Remove
 * kept. The page tab draws its own row (`pages/downloads`).
 */
export function DownloadRow({
  item,
  highlighted = false,
  draggable = false
}: {
  item: DownloadItem
  /** Marked for attention (a notification was clicked): scrolled into view and tinted. */
  highlighted?: boolean
  /** The host can start an OS drag of the finished file. */
  draggable?: boolean
}): JSX.Element {
  const ref = useRef<HTMLLIElement>(null)
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [highlighted])
  const active = isActiveDownload(item)
  const openable = isOnDisk(item)
  const flagged = showsDangerDecision(item)
  const deleted = isDeletedRow(item)
  const name = displayName(item)
  const status = downloadStatus(item)
  const open = (): void => {
    if (openable) downloadsEngine.open(item.id)
  }
  const contextMenu = (e: ReactMouseEvent<HTMLLIElement>): void => {
    e.preventDefault()
    e.stopPropagation()
    // A right click opens at the pointer; the menu key and Shift+F10 come without one and
    // open on the row's text, with the keyboard on the first item.
    if (e.button === 2) {
      downloadsEngine.contextMenu(item.id, { x: e.clientX, y: e.clientY })
    } else {
      const box = e.currentTarget.getBoundingClientRect()
      downloadsEngine.contextMenu(item.id, {
        x: Math.round(box.left + 36),
        y: Math.round(box.bottom - 4),
        keyboard: true
      })
    }
  }
  return (
    <li
      ref={ref}
      className={cn('zen-v2-row zen-dl-row group/row', highlighted && 'zen-dl-row-marked')}
      data-state={item.state}
      data-download-id={item.id}
      data-flagged={flagged || undefined}
      data-deleted={deleted || undefined}
      draggable={draggable && openable}
      onDragStart={(e) => {
        // The OS drag is the host's: hand the file over and drop the HTML5 one.
        e.preventDefault()
        downloadsEngine.dragOut(item.id)
      }}
      onDoubleClick={open}
      onContextMenu={contextMenu}
      onKeyDown={(e) => {
        if (openable && e.key === 'Enter' && e.target === e.currentTarget) {
          e.preventDefault()
          open()
        }
      }}
      tabIndex={0}
      aria-label={`${name}. ${status.text}`}
    >
      <FileTypeGlyph item={item} />
      <div className="zen-dl-row-text">
        <FileName
          name={name}
          title={item.savePath || item.url}
          dim={item.state === 'cancelled' || deleted}
          onOpen={openable ? open : undefined}
        />
        <StatusLine item={item} />
        {status.detail && <p className="zen-dl-detail">{status.detail}</p>}
        {active && <DownloadProgressBar item={item} />}
      </div>
      {flagged ? (
        <DangerActions item={item} />
      ) : (
        <div className="zen-dl-actions">
          <DownloadActions item={item} />
        </div>
      )}
    </li>
  )
}
