import type { JSX, KeyboardEvent, ReactNode } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
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
  Settings2,
  Trash2,
  X,
  type LucideIcon
} from 'lucide-react'
import type { DownloadItem, UIState } from '@shared/types'
import {
  awaitsAutoResume,
  awaitsDecision,
  canResumeDownload,
  canRetryDownload,
  displayName,
  isActiveDownload,
  isInsecureBlocked
} from '@shared/downloadsShell'
import { useEscape } from '@renderer/hooks/useEscape'
import { useBackSurface } from '@renderer/lib/back'
import { downloadStatus } from '@renderer/lib/downloadText'
import { downloadsEngine } from '@renderer/lib/downloadsEngine'
import {
  dangerSummary,
  decisionLabels,
  fileGlyphFor,
  hasClearable,
  insecureSummary,
  isDeletedRow,
  isOnDisk,
  splitFileName,
  type FileGlyph
} from '@renderer/lib/downloadsView'
import { openSettings } from '@renderer/lib/pages'
import { FrameDialogPortal, useFrameDialog } from '@renderer/lib/portals'
import { browserStore, closeOverlay } from '@renderer/lib/ui'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'

/** The desktop row's file-type glyphs (`fileGlyphFor`), drawn at the phone's 20 px (§9.3). */
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

/** How long a Keep / Delete button spins before it gives up on a reply that never came (§9.30). */
const BUSY_TIMEOUT_MS = 8000

/** How often "2 min ago" moves while the sheet is up. */
const AGE_TICK_MS = 30_000
/** How often a `Resuming in N s…` row counts down; only while one does (HB-43). */
const COUNTDOWN_TICK_MS = 1000

/**
 * The Android downloads surface: Chrome's download list in the phone sheet chassis (v2 §6,
 * §9.16, §9.24–§9.25). Newest first, on the shared `.zen-v2-row` (§9.34) as §9.2 two-line
 * rows: a running row shows its progress and time left with Pause and Cancel, a paused or
 * resumable interrupted one Resume, a failed one `Failed · <the engine's reason>` with Retry
 * (the same states the desktop bubble and page show, #161; the interface's verbs table names
 * the verb per state), one the downloader will try again itself `Resuming in N s…` with Resume
 * and Cancel (HB-43); a finished row opens on tap and can be shown in the system Downloads app
 * or taken off the list, and one whose file the engine found gone reads `Deleted` with Retry,
 * as Chrome's does; a flagged file waits behind its warning – the tier named, `Blocked ·
 * Dangerous` or `Blocked · Suspicious`, over the verdict's sentence – with Keep and Delete, and
 * a transfer refused as insecure (HB-44) behind `Blocked · Insecure download` with Keep anyway
 * (while the type allows it) and Discard, the pressed one busy until the engine answers. The
 * header's trailing control opens Settings › Downloads; an action row under the list, past a
 * hairline, clears the finished rows. As the sheet opens, the finished files are checked for
 * still being on disk, so a row whose file went since reads Deleted (the desktop page does the
 * same).
 *
 * The overlay host renders it inside the shell's content column, which is chrome that goes
 * inert under a sheet (`holdChromeInert`, lib/portals.tsx), so the sheet must not mount there:
 * it is placed through the frame's dialog host (`FrameDialogPortal`, the way the phone panels'
 * and the Settings tab's sheets are), over the content frame, drawing the stack's one scrim
 * itself.
 */
export function DownloadsSheet({ state }: { state: UIState }): JSX.Element {
  return (
    <FrameDialogPortal>
      <HostedDownloadsSheet state={state} />
    </FrameDialogPortal>
  )
}

/** The sheet inside the host: registered with it as a dialog that draws its own scrim. */
function HostedDownloadsSheet({ state }: { state: UIState }): JSX.Element {
  const items = downloadsEngine.list(state)
  const sheet = useRef<BottomSheetHandle>(null)
  const titleId = useId()
  /** The sheet is sliding away to hand over to another surface: leave the overlay stack to it. */
  const handoff = useRef(false)

  // The system back gesture pulls the sheet down with the finger; the back button, a hardware
  // Escape and a scrim tap slide it away.
  const dismiss = (): void => sheet.current?.dismiss()
  useFrameDialog({ onScrimPress: dismiss, ownScrim: true })
  useBackSurface({
    name: 'downloads',
    onProgress: (progress) => sheet.current?.backProgress(progress),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  useEscape(dismiss)

  useEffect(() => {
    const current = browserStore.get().state
    if (current) downloadsEngine.refreshFiles(downloadsEngine.list(current))
  }, [])

  // "2 min ago" moves while the sheet is up; a row counting down to its automatic resume moves
  // every second, while there is one (the text alone changes: no layout property animates).
  const counting = items.some(awaitsAutoResume)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    const timer = setInterval(
      () => setNow(Date.now()),
      counting ? COUNTDOWN_TICK_MS : AGE_TICK_MS
    )
    return () => clearInterval(timer)
  }, [counting])

  const clearable = hasClearable(items)
  // Rows coming and going (or growing a Keep / Delete row, or the Clear list row appearing)
  // re-measure the detents; a progress tick does not, since a re-measure also scrolls the list
  // back to its top.
  const contentKey =
    (items.map((item) => `${item.id}${awaitsDecision(item) ? '!' : ''}`).join(',') || 'empty') +
    (clearable ? '+clear' : '')

  const toSettings = (): void => {
    handoff.current = true
    sheet.current?.dismiss(() => {
      closeOverlay()
      openSettings('downloads')
    })
  }

  return (
    <BottomSheet
      ref={sheet}
      hosted
      onDismissed={() => {
        if (!handoff.current) closeOverlay()
      }}
      contentKey={contentKey}
      handleLabel="Resize downloads"
      labelledBy={titleId}
      header={
        <>
          <h2 id={titleId} className="zen-sheet-title">
            Downloads
          </h2>
          <button
            type="button"
            className="zen-sheet-header-control"
            data-side="trailing"
            aria-label="Downloads settings"
            title="Downloads settings"
            onClick={toSettings}
          >
            <Settings2 className="h-5 w-5" strokeWidth={1.75} />
          </button>
        </>
      }
    >
      {items.length === 0 ? (
        <p className="zen-sheet-empty">Files you download will appear here</p>
      ) : (
        <ul className="pb-2">
          {items.map((item) => (
            <DownloadRow key={item.id} item={item} now={now} />
          ))}
          {clearable && (
            <>
              <li aria-hidden className="zen-sheet-sep" />
              <li>
                <button
                  type="button"
                  className="zen-sheet-item"
                  onClick={() => downloadsEngine.removeCompleted()}
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

/**
 * One download: the shared row as a two-line row (64, growing around a progress bar or the
 * Keep / Delete pair). Its accessible row is the first child – a button while the file can be
 * opened, else a focusable box – named `<name>. <status>` and holding the glyph and the text;
 * the trailing 44 icon buttons are its siblings, since a control inside a button is not valid
 * ARIA and Android's accessibility tree makes a button a leaf (the phone lists' row shape). The
 * status is ink only: the danger ink for a failure or a dangerous verdict, the warning ink for a
 * lesser one, the deemphasised ink otherwise; a flagged row shows the verdict's sentence there
 * and says Chrome's blocked status in its name. A record without a file dims its glyph, and a
 * cancelled or Deleted one its name too, as the desktop row does.
 *
 * The row is a target only while its file opens: then the whole row takes the primitive's press
 * fill. Every other row – running, paused, failed, cancelled, Deleted, waiting on a verdict or
 * blocked as insecure – is the static form (§9.34, `data-static`): its icon buttons or its
 * Keep / Delete (Keep anyway / Discard) are the targets, the row around them draws no fill and
 * no pointer cursor, and its body keeps no role; the body stays a focusable box so the row
 * reads as one unit (`<name>. <status>. <the verdict's sentence>`) before its controls.
 *
 * A row waiting on the user names its tier on the status line (`Blocked · Dangerous`, `Blocked
 * · Suspicious`, `Blocked · Insecure download`) and carries the sentence under it, as the
 * desktop row's detail does; the ink is the tier's. A row counting down to the downloader's
 * own next attempt (HB-43) reads `Resuming in N s…` in the plain ink – nothing has been given
 * up on – and keeps Resume (now) and Cancel, the interface's verbs for that state.
 */
export function DownloadRow({ item, now }: { item: DownloadItem; now: number }): JSX.Element {
  const active = isActiveDownload(item)
  const flagged = awaitsDecision(item)
  const blocked = isInsecureBlocked(item)
  const scheduled = awaitsAutoResume(item)
  const deleted = isDeletedRow(item)
  const openable = isOnDisk(item)
  const resumable = canResumeDownload(item)
  const name = displayName(item)
  const status = downloadStatus(item, now)
  const summary = blocked ? insecureSummary(item) : flagged ? dangerSummary(item.danger) : ''
  const tone: 'danger' | 'warn' | undefined = scheduled
    ? undefined
    : item.state === 'interrupted' || (flagged && item.danger.level === 'dangerous')
      ? 'danger'
      : flagged
        ? 'warn'
        : undefined
  const Glyph = GLYPHS[fileGlyphFor(name, item.mimeType)]
  const { head, tail } = splitFileName(name)
  const e = downloadsEngine
  const open = (): void => {
    if (openable) e.open(item.id)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!openable || event.target !== event.currentTarget) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      open()
    }
  }
  return (
    <li
      className="zen-v2-row zen-downloads-row"
      data-state={item.state}
      data-static={openable ? undefined : ''}
      data-flagged={flagged || undefined}
      data-deleted={deleted || undefined}
    >
      <div
        role={openable ? 'button' : undefined}
        tabIndex={0}
        aria-label={summary ? `${name}. ${status}. ${summary}` : `${name}. ${status}`}
        className="zen-downloads-main"
        data-gone={
          item.state === 'cancelled' ||
          item.state === 'interrupted' ||
          blocked ||
          deleted ||
          undefined
        }
        data-dim={item.state === 'cancelled' || deleted || undefined}
        onClick={openable ? open : undefined}
        onKeyDown={onKeyDown}
      >
        <Glyph className="zen-downloads-glyph" strokeWidth={1.75} aria-hidden />
        <span className="zen-downloads-text">
          <span className="zen-downloads-name">
            <span className="zen-downloads-name-text" title={item.savePath || item.url}>
              <span className="zen-downloads-name-head">{head}</span>
              {tail && <span className="zen-downloads-name-tail">{tail}</span>}
            </span>
            {item.private && <span className="zen-v2-badge">Private</span>}
          </span>
          <span className="zen-downloads-status" data-tone={tone}>
            {status}
          </span>
          {summary && <span className="zen-downloads-detail">{summary}</span>}
          {active && <ProgressBar item={item} />}
        </span>
      </div>
      {flagged ? (
        <DecisionActions item={item} />
      ) : (
        <div className="zen-downloads-actions">
          {item.state === 'progressing' && (
            <IconButton label="Pause" icon={Pause} onClick={() => e.pause(item.id)} />
          )}
          {resumable && <IconButton label="Resume" icon={Play} onClick={() => e.resume(item.id)} />}
          {!resumable && canRetryDownload(item) && (
            <IconButton label="Retry" icon={RotateCw} onClick={() => e.retry(item.id)} />
          )}
          {active || scheduled ? (
            <IconButton label="Cancel" icon={X} onClick={() => e.cancel(item.id)} />
          ) : (
            <>
              {openable && (
                <IconButton
                  label="Show in the Downloads app"
                  icon={FolderOpen}
                  onClick={() => e.showInFolder(item.id)}
                />
              )}
              <IconButton
                label="Remove from list"
                icon={Trash2}
                onClick={() => e.remove(item.id)}
              />
            </>
          )}
        </div>
      )}
    </li>
  )
}

/** The 3 px bar under a running row: the fill scales from the left; unknown totals sweep. */
function ProgressBar({ item }: { item: DownloadItem }): JSX.Element {
  const known = item.totalBytes > 0
  const fraction = known ? Math.min(1, item.receivedBytes / item.totalBytes) : null
  return (
    <span
      className="zen-downloads-progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}
      data-paused={item.state === 'paused' || undefined}
      data-indeterminate={(fraction === null && item.state === 'progressing') || undefined}
    >
      <span
        className="zen-downloads-progress-bar"
        style={fraction === null ? undefined : { transform: `scaleX(${fraction})` }}
      />
    </span>
  )
}

/**
 * The pair for a row waiting on the user, worded per state by the interface's verbs table
 * (`decisionLabels`; the desktop rows share it): Keep / Delete for a file the engine flagged,
 * weighted as Chrome's bubble weights them, Keep anyway / Discard for a transfer refused as
 * insecure – or Discard alone, spanning the row (§9.11), when the type is one Chrome offers no
 * Keep for. The row's own footer under its text: two peers splitting the width at an 8 gap,
 * the destructive or prominent one trailing (§9.11). The pressed one is busy until the engine
 * answers – the row leaves its waiting state or goes – and the other waits disabled meanwhile
 * (§9.30: busy keeps its ink and width under a 16 px spinner and says `aria-busy`; disabled is
 * the whole control at .4).
 */
function DecisionActions({ item }: { item: DownloadItem }): JSX.Element {
  const labels = decisionLabels(item)
  const [busy, setBusy] = useState<'keep' | 'discard' | null>(null)
  useEffect(() => {
    if (!busy) return
    const timer = setTimeout(() => setBusy(null), BUSY_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [busy])
  const decide = (which: 'keep' | 'discard'): void => {
    if (busy) return
    setBusy(which)
    if (which === 'keep') downloadsEngine.acceptDanger(item.id)
    else downloadsEngine.discard(item.id)
  }
  // Keep leads and Delete trails, as the desktop rows order them: the destructive or prominent
  // action on the trailing side (§9.11).
  return (
    <div className="zen-downloads-decision">
      {labels.keep !== null && (
        <BusyButton
          primary={labels.prominent === 'keep'}
          busy={busy === 'keep'}
          disabled={busy === 'discard'}
          onClick={() => decide('keep')}
        >
          {labels.keep}
        </BusyButton>
      )}
      <BusyButton
        primary={labels.prominent === 'discard'}
        danger={labels.prominent !== 'discard'}
        busy={busy === 'discard'}
        disabled={busy === 'keep'}
        onClick={() => decide('discard')}
      >
        {labels.discard}
      </BusyButton>
    </div>
  )
}

/** The v2 button with the §9.30 busy state, as the extensions UI and the new tab sheet draw it. */
function BusyButton({
  children,
  onClick,
  primary,
  danger,
  busy,
  disabled
}: {
  children: ReactNode
  onClick: () => void
  primary?: boolean
  danger?: boolean
  busy?: boolean
  disabled?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      className="zen-v2-button"
      data-primary={primary || undefined}
      data-danger={danger || undefined}
      aria-busy={busy || undefined}
      disabled={disabled}
      onClick={onClick}
    >
      {busy ? (
        <>
          <span className="zen-v2-button-label">{children}</span>
          <span className="zen-v2-spinner" aria-hidden />
        </>
      ) : (
        children
      )}
    </button>
  )
}

/** A row's control: the shared `.zen-v2-icon-button` (§9.34), 44 with a 20 glyph on a phone. */
function IconButton({
  label,
  icon: Icon,
  onClick
}: {
  label: string
  icon: LucideIcon
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      className="zen-v2-icon-button"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <Icon aria-hidden />
    </button>
  )
}
