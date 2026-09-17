import type { JSX } from 'react'
import { Download } from 'lucide-react'
import type { UIState } from '@shared/types'
import { allPaused, progressBarFor } from '@shared/downloadsShell'
import { downloadsEngine } from '@renderer/lib/downloadsEngine'
import { downloadButtonVisible, downloadsUi, toggleDownloadBubble } from '@renderer/lib/downloads'
import { cn } from '@renderer/lib/utils'

/** Ring geometry around the 16px glyph inside the 28px button. */
const RING_SIZE = 24
const RING_STROKE = 1.5
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2
const RING_LENGTH = 2 * Math.PI * RING_RADIUS

/**
 * The toolbar's downloads button (Chrome 112+): appears when a transfer starts, pulses, wears a
 * progress ring while anything is in flight and a count badge for items that finished while the
 * bubble was closed; leaves five seconds after the last transfer unless Settings keep it.
 */
export function DownloadButton({
  state,
  activeTabId
}: {
  state: UIState
  activeTabId: string | null
}): JSX.Element | null {
  const ui = downloadsUi.use()
  if (!downloadButtonVisible(state, ui)) return null

  const items = downloadsEngine.list(state)
  // The ring shows the engine's aggregate of this window's in-flight transfers.
  const progress = state.downloadsProgress
  const bar = progressBarFor(progress, allPaused(items))
  const unseen = ui.unseen.filter((id) => items.some((i) => i.id === id))
  const failed = unseen.some((id) => items.find((i) => i.id === id)?.state === 'interrupted')
  const open = ui.open && !ui.closing
  const label =
    progress.active > 0
      ? `Downloads, ${progress.active} in progress`
      : unseen.length > 0
        ? `Downloads, ${unseen.length} new`
        : 'Downloads'

  return (
    <button
      type="button"
      data-zen-downloads-button
      className={cn(
        'zen-toolbar-button zen-dl-button-toolbar relative',
        open && 'bg-[var(--zen-element-bg)]'
      )}
      title={label}
      aria-label={label}
      aria-expanded={open}
      aria-haspopup="dialog"
      onClick={() => toggleDownloadBubble(activeTabId)}
    >
      {/* Remounted per started download so the start pulse plays again. */}
      <span
        key={ui.pulse}
        className={cn(
          'zen-dl-glyph-body flex items-center justify-center',
          ui.pulse > 0 && 'zen-dl-glyph-pulse'
        )}
      >
        <Download className="h-4 w-4" strokeWidth={1.5} />
      </span>
      {bar.mode !== 'none' && (
        <svg
          className={cn(
            'zen-dl-ring pointer-events-none absolute',
            bar.mode === 'paused' && 'zen-dl-ring-paused'
          )}
          width={RING_SIZE}
          height={RING_SIZE}
          viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
          aria-hidden
        >
          <circle
            className="zen-dl-ring-track"
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            fill="none"
            strokeWidth={RING_STROKE}
          />
          <circle
            className={cn('zen-dl-ring-value', bar.mode === 'indeterminate' && 'zen-dl-ring-spin')}
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            fill="none"
            strokeWidth={RING_STROKE}
            strokeLinecap="round"
            strokeDasharray={RING_LENGTH}
            strokeDashoffset={
              bar.mode === 'indeterminate'
                ? RING_LENGTH * 0.75
                : RING_LENGTH * (1 - Math.max(0, Math.min(1, bar.value)))
            }
          />
        </svg>
      )}
      {unseen.length > 0 && !open && (
        <span className={cn('zen-dl-badge', failed && 'zen-dl-badge-failed')} aria-hidden>
          {unseen.length > 9 ? '9+' : unseen.length}
        </span>
      )}
    </button>
  )
}
