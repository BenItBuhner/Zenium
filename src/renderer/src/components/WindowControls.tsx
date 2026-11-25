import type { JSX } from 'react'
import { Minus, Square, X, Copy } from 'lucide-react'
import { run } from '@renderer/lib/api'
import { useBrowser } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { CAPTION_BUTTONS_WIDTH, nativeCaption, ownCaption } from '@renderer/lib/caption'
import { CAPTION_HEIGHT } from '@shared/theme'
import { TOOLBAR_STROKE } from './v2/controls'

/**
 * Zenium's window buttons: Linux, and a Windows browser window (`ownCaption`). macOS uses native
 * traffic lights; Windows popups and app windows get the OS's own over the chrome (Window
 * Controls Overlay, `nativeCaption`); mobile hosts have none. Three §9.3 toolbar icon buttons in the
 * window family (design language v2 §9.29): the 28 box, a 16 glyph at `TOOLBAR_STROKE`, the
 * window's hover fill on each – Close included, as the GTK title bars they stand in for draw it;
 * a danger fill would be a page colour on the window, and status colours are ink alone (§9.29).
 * 4 apart like the toolbar row's buttons (§5). Each is named for the tree and carries the same
 * word as its chrome tooltip (`data-tooltip`, lib/tooltip.ts; a11y-26) in place of a native
 * `title`.
 */
export function WindowControls({ compact = false }: { compact?: boolean }): JSX.Element | null {
  const state = useBrowser()
  if (state.platform === 'darwin' || state.window.fullscreen) return null
  if (!state.capabilities.windowControls || nativeCaption(state) || ownCaption(state)) return null
  if (compact) {
    return (
      <div className="zen-no-drag flex items-center">
        <button
          type="button"
          className="zen-toolbar-button"
          aria-label="Close"
          data-tooltip="Close"
          onClick={() => run('window.close', undefined)}
        >
          <X className="h-4 w-4" strokeWidth={TOOLBAR_STROKE} />
        </button>
      </div>
    )
  }
  return (
    <div className="zen-no-drag flex items-center gap-1">
      <button
        type="button"
        className="zen-toolbar-button"
        aria-label="Minimize"
        data-tooltip="Minimize"
        onClick={() => run('window.minimize', undefined)}
      >
        <Minus className="h-4 w-4" strokeWidth={TOOLBAR_STROKE} />
      </button>
      <button
        type="button"
        className="zen-toolbar-button"
        aria-label={state.window.maximized ? 'Restore' : 'Maximize'}
        data-tooltip={state.window.maximized ? 'Restore' : 'Maximize'}
        onClick={() => run('window.toggleMaximize', undefined)}
      >
        {state.window.maximized ? (
          <Copy className="h-4 w-4 -scale-x-100" strokeWidth={TOOLBAR_STROKE} />
        ) : (
          <Square className="h-4 w-4" strokeWidth={TOOLBAR_STROKE} />
        )}
      </button>
      <button
        type="button"
        className="zen-toolbar-button"
        aria-label="Close"
        data-tooltip="Close"
        onClick={() => run('window.close', undefined)}
      >
        <X className="h-4 w-4" strokeWidth={TOOLBAR_STROKE} />
      </button>
    </div>
  )
}

/**
 * A Windows browser window's minimise / maximise / close (`ownCaption`), drawn as the OS draws
 * them in the overlay the window used to carry: three 46-wide buttons the caption's height,
 * flush in the window's top trailing corner, 10px line glyphs in the chrome's ink, a light fill
 * on hover and Windows' red under Close. `solid` lays the chrome's colour behind them, for the
 * times they come out over the page (`CaptionReveal`).
 */
export function CaptionButtons({ solid = false }: { solid?: boolean }): JSX.Element | null {
  const state = useBrowser()
  if (!ownCaption(state) || state.window.fullscreen) return null
  const maximized = state.window.maximized
  const button =
    'flex h-full w-[46px] items-center justify-center outline-none transition-colors duration-100'
  const plain = 'hover:bg-[rgb(var(--zen-fg-rgb)/0.09)] active:bg-[rgb(var(--zen-fg-rgb)/0.05)]'
  return (
    <div
      className="zen-no-drag flex"
      style={{
        width: CAPTION_BUTTONS_WIDTH,
        height: CAPTION_HEIGHT,
        color: 'var(--zen-fg)',
        background: solid ? 'var(--zen-bg-solid)' : undefined
      }}
      data-testid="caption-buttons"
    >
      <button
        type="button"
        className={cn(button, plain)}
        aria-label="Minimize"
        data-tooltip="Minimize"
        onClick={() => run('window.minimize', undefined)}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <rect x="0" y="4.5" width="10" height="1" fill="currentColor" />
        </svg>
      </button>
      <button
        type="button"
        className={cn(button, plain)}
        aria-label={maximized ? 'Restore' : 'Maximize'}
        data-tooltip={maximized ? 'Restore' : 'Maximize'}
        onClick={() => run('window.toggleMaximize', undefined)}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none">
          {maximized ? (
            <g stroke="currentColor" strokeWidth="1">
              <rect x="0.5" y="2.5" width="7" height="7" rx="1" />
              <path d="M2.5 2.5V1.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1" />
            </g>
          ) : (
            <rect x="0.5" y="0.5" width="9" height="9" rx="1" stroke="currentColor" />
          )}
        </svg>
      </button>
      <button
        type="button"
        className={cn(
          button,
          'hover:bg-[#c42b1c] hover:text-white active:bg-[#c42b1c]/90 active:text-white'
        )}
        aria-label="Close"
        data-tooltip="Close"
        onClick={() => run('window.close', undefined)}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
    </div>
  )
}
