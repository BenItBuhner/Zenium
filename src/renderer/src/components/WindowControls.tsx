import type { JSX } from 'react'
import { Minus, Square, X, Copy } from 'lucide-react'
import { run } from '@renderer/lib/api'
import { useBrowser } from '@renderer/lib/ui'

/** Linux/Windows window buttons (macOS uses native traffic lights). */
export function WindowControls(): JSX.Element {
  const state = useBrowser()
  return (
    <div className="zen-no-drag flex items-center gap-0.5">
      <button
        type="button"
        className="zen-toolbar-button h-7 w-7"
        title="Minimize"
        onClick={() => run('window.minimize', undefined)}
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        className="zen-toolbar-button h-7 w-7"
        title={state.window.maximized ? 'Restore' : 'Maximize'}
        onClick={() => run('window.toggleMaximize', undefined)}
      >
        {state.window.maximized ? (
          <Copy className="h-3 w-3 -scale-x-100" />
        ) : (
          <Square className="h-3 w-3" />
        )}
      </button>
      <button
        type="button"
        className="zen-toolbar-button h-7 w-7 hover:!bg-red-500 hover:!text-white"
        title="Close"
        onClick={() => run('window.close', undefined)}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
