import type { JSX } from 'react'
import { Minus, Square, X, Copy } from 'lucide-react'
import { run } from '@renderer/lib/api'
import { useBrowser } from '@renderer/lib/ui'
import { TOOLBAR_STROKE } from './v2/controls'

/**
 * Linux window buttons. macOS uses native traffic lights; Windows draws its own over the chrome
 * (Window Controls Overlay); mobile hosts have none. Three §9.3 toolbar icon buttons in the
 * window family (design language v2 §9.29): the 28 box, a 16 glyph at `TOOLBAR_STROKE`, the
 * window's hover fill on each – Close included, as the GTK title bars they stand in for draw it;
 * a danger fill would be a page colour on the window, and status colours are ink alone (§9.29).
 * 4 apart like the toolbar row's buttons (§5).
 */
export function WindowControls({ compact = false }: { compact?: boolean }): JSX.Element | null {
  const state = useBrowser()
  if (state.platform === 'darwin' || state.window.fullscreen) return null
  if (!state.capabilities.windowControls || state.capabilities.windowControlsOverlay) return null
  if (compact) {
    return (
      <div className="zen-no-drag flex items-center">
        <button
          type="button"
          className="zen-toolbar-button"
          title="Close"
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
        title="Minimize"
        onClick={() => run('window.minimize', undefined)}
      >
        <Minus className="h-4 w-4" strokeWidth={TOOLBAR_STROKE} />
      </button>
      <button
        type="button"
        className="zen-toolbar-button"
        title={state.window.maximized ? 'Restore' : 'Maximize'}
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
        title="Close"
        onClick={() => run('window.close', undefined)}
      >
        <X className="h-4 w-4" strokeWidth={TOOLBAR_STROKE} />
      </button>
    </div>
  )
}
