import type { JSX } from 'react'
import {
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
import { fileGlyphFor, engineFieldsOf, type FileGlyph } from '@shared/downloads'
import {
  canRetryDownload,
  canResumeDownload,
  downloadEngine,
  needsKeepDiscard
} from '@renderer/lib/downloadsEngine'
import { cn } from '@renderer/lib/utils'

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

/** The file-type glyph in its box: 20 in a 32 box on desktop rows, 16 in 24 for compact ones. */
export function FileTypeGlyph({
  item,
  size = 'row',
  className
}: {
  item: DownloadItem
  size?: 'row' | 'compact'
  className?: string
}): JSX.Element {
  const Icon = GLYPHS[fileGlyphFor(item.filename, item.mimeType)]
  const dimmed = item.state === 'cancelled' || engineFieldsOf(item).removed === true
  return (
    <span
      className={cn(
        'zen-download-glyph flex shrink-0 items-center justify-center',
        size === 'row' ? 'h-8 w-8' : 'h-6 w-6',
        dimmed && 'opacity-50',
        className
      )}
      aria-hidden
    >
      <Icon className={size === 'row' ? 'h-5 w-5' : 'h-4 w-4'} />
    </span>
  )
}

/** The 3px bar: the accent fill scales from the left; unknown totals sweep. */
export function DownloadProgressBar({ item }: { item: DownloadItem }): JSX.Element {
  const known = item.totalBytes > 0
  const value = known ? Math.min(1, item.receivedBytes / item.totalBytes) : 0
  return (
    <div
      className="zen-download-bar"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={known ? Math.round(value * 100) : undefined}
      data-paused={item.state === 'paused' || undefined}
    >
      <div
        className={cn('zen-download-bar-fill', !known && 'zen-download-bar-sweep')}
        style={known ? { transform: `scaleX(${value})` } : undefined}
      />
    </div>
  )
}

function IconAction({
  title,
  icon: Icon,
  onClick,
  danger
}: {
  title: string
  icon: LucideIcon
  onClick: () => void
  danger?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      className={cn('zen-toolbar-button h-7 w-7', danger && 'text-[var(--zen-danger)]')}
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      <Icon className="h-4 w-4" />
    </button>
  )
}

/**
 * The row's controls for its state: Pause / Resume and Cancel while in flight, Retry after a
 * failure (when the engine exposes it), Show in folder when the file exists, and Remove from
 * list for anything settled.
 */
export function DownloadActions({
  item,
  showInFolder = true
}: {
  item: DownloadItem
  showInFolder?: boolean
}): JSX.Element {
  const id = item.id
  const extra = engineFieldsOf(item)
  const onDisk = item.state === 'completed' && extra.removed !== true
  const resumeInterrupted = item.state === 'interrupted' && canResumeDownload(item)
  const retry = canRetryDownload(item) && !resumeInterrupted
  return (
    <>
      {item.state === 'progressing' && (
        <IconAction title="Pause" icon={Pause} onClick={() => downloadEngine.pause(id)} />
      )}
      {(item.state === 'paused' || resumeInterrupted) && (
        <IconAction title="Resume" icon={Play} onClick={() => downloadEngine.resume(id)} />
      )}
      {(item.state === 'progressing' || item.state === 'paused') && (
        <IconAction title="Cancel" icon={X} onClick={() => downloadEngine.cancel(id)} />
      )}
      {retry && <IconAction title="Retry" icon={RotateCw} onClick={() => undefined} />}
      {onDisk && showInFolder && !needsKeepDiscard(item) && (
        <IconAction
          title="Show in folder"
          icon={FolderOpen}
          onClick={() => downloadEngine.showInFolder(id)}
        />
      )}
      {item.state !== 'progressing' && item.state !== 'paused' && (
        <IconAction
          title="Remove from list"
          icon={Trash2}
          onClick={() => downloadEngine.remove(id)}
        />
      )}
    </>
  )
}

/** Keep / Discard for a file the danger table flagged; hidden until the engine lands. */
export function DangerPills({ item }: { item: DownloadItem }): JSX.Element | null {
  if (!needsKeepDiscard(item)) return null
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        className="zen-download-btn"
        onClick={(e) => {
          e.stopPropagation()
        }}
      >
        Keep
      </button>
      <button
        type="button"
        className="zen-download-btn"
        data-danger=""
        onClick={(e) => {
          e.stopPropagation()
        }}
      >
        Discard
      </button>
    </div>
  )
}
