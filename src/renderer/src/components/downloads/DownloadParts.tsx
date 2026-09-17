import type { JSX, ReactNode } from 'react'
import {
  ExternalLink,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileText,
  FileVideo,
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
import type { DownloadItem } from '@shared/types'
import { canResumeDownload, canRetryDownload } from '@shared/downloadsShell'
import { downloadsEngine } from '@renderer/lib/downloadsEngine'
import { downloadStatus, fileGlyphFor, isOnDisk, type FileGlyph } from '@renderer/lib/downloadsView'
import { cn } from '@renderer/lib/utils'

/*
 * Pieces a download row is made of, shared by the bubble and the `zen://downloads` page: the
 * file-type glyph, the status line, the thin progress bar, the hover actions and the Keep /
 * Discard pair for flagged files, all on the engine's commands (PR #69).
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

/** The 16px file-type glyph, dimmed for records whose file is gone. */
export function FileTypeGlyph({ item }: { item: DownloadItem }): JSX.Element {
  const Icon = GLYPHS[fileGlyphFor(item.finalName || item.filename, item.mimeType)]
  const gone = item.state === 'cancelled' || item.state === 'interrupted'
  return (
    <span
      className={cn('zen-dl-glyph flex h-5 w-4 shrink-0 items-center', gone && 'opacity-50')}
      aria-hidden
    >
      <Icon className="h-4 w-4" strokeWidth={1.5} />
    </span>
  )
}

/** The one-line status under the name, set in the tone the status asks for. */
export function StatusLine({
  item,
  suffix
}: {
  item: DownloadItem
  /** Trails the status after a separator (the page adds the source host). */
  suffix?: string
}): JSX.Element {
  const status = downloadStatus(item)
  return (
    <div className="zen-dl-status truncate text-[13px] leading-[18px] tabular-nums">
      {status.text && (
        <span
          className={cn(
            status.tone === 'warn' && 'zen-dl-status-warn',
            status.tone === 'danger' && 'zen-dl-status-danger'
          )}
        >
          {status.text}
        </span>
      )}
      {suffix && (status.text ? ` · ${suffix}` : suffix)}
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

/** A 32-tall text button of the downloads surfaces (secondary by default). */
export function DlButton({
  children,
  onClick,
  tone = 'secondary',
  title,
  className
}: {
  children: ReactNode
  onClick: () => void
  tone?: 'secondary' | 'primary' | 'danger'
  title?: string
  className?: string
}): JSX.Element {
  return (
    <button
      type="button"
      className={cn(
        'zen-dl-button',
        tone === 'primary' && 'zen-dl-button-primary',
        tone === 'danger' && 'zen-dl-button-danger',
        className
      )}
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      {children}
    </button>
  )
}

function IconAction({
  title,
  icon: Icon,
  onClick,
  pressed
}: {
  title: string
  icon: LucideIcon
  onClick: () => void
  /** A toggle: rendered pressed while on. */
  pressed?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      className={cn('zen-toolbar-button', pressed && 'zen-dl-action-on')}
      title={title}
      aria-label={title}
      aria-pressed={pressed}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      <Icon className="h-4 w-4" strokeWidth={1.5} />
    </button>
  )
}

/**
 * The row's controls for its state: Pause / Resume, Cancel and "Open when done" while in
 * flight, Resume for an interrupted transfer the server lets continue and Retry for the rest
 * of the failed and cancelled ones, Show in folder when the file exists, and Remove from list
 * for anything settled.
 */
export function DownloadActions({ item }: { item: DownloadItem }): JSX.Element {
  const id = item.id
  const e = downloadsEngine
  const inFlight = item.state === 'progressing' || item.state === 'paused'
  const resumable = canResumeDownload(item)
  return (
    <>
      {item.state === 'progressing' && (
        <IconAction title="Pause" icon={Pause} onClick={() => e.pause(id)} />
      )}
      {resumable && <IconAction title="Resume" icon={Play} onClick={() => e.resume(id)} />}
      {!resumable && canRetryDownload(item) && (
        <IconAction title="Retry" icon={RotateCw} onClick={() => e.retry(id)} />
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
        <IconAction title="Show in folder" icon={FolderOpen} onClick={() => e.showInFolder(id)} />
      )}
      {!inFlight && (
        <IconAction title="Remove from list" icon={Trash2} onClick={() => e.remove(id)} />
      )}
    </>
  )
}

/** Keep / Discard for a file the engine flagged; Discard deletes it. */
export function DangerActions({ item }: { item: DownloadItem }): JSX.Element {
  return (
    <div className="flex shrink-0 items-center gap-2">
      <DlButton onClick={() => downloadsEngine.acceptDanger(item.id)}>Keep</DlButton>
      <DlButton tone="danger" onClick={() => downloadsEngine.discard(item.id)}>
        Discard
      </DlButton>
    </div>
  )
}
