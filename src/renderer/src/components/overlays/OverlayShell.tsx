import { X } from 'lucide-react'
import type { ReactNode, JSX } from 'react'
import { closeOverlay } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'

interface Props {
  title: string
  children: ReactNode
  /** `dock` → left-docked sidebar panel; `dialog` → centred card; `full` → fills the content area. */
  variant?: 'dock' | 'dialog' | 'full'
  actions?: ReactNode
  className?: string
}

/** Common chrome for panels that open over the content area. */
export function OverlayShell({
  title,
  children,
  variant = 'dock',
  actions,
  className
}: Props): JSX.Element {
  return (
    <div className="absolute inset-0 z-30 flex" onMouseDown={() => closeOverlay()}>
      <div
        className={cn(
          'zen-panel zen-animate-in flex flex-col overflow-hidden',
          variant === 'dock' && 'm-3 w-[380px] max-w-full',
          variant === 'dialog' &&
            'm-auto w-[560px] max-w-[calc(100%-32px)] max-h-[calc(100%-32px)]',
          variant === 'full' && 'm-3 flex-1',
          className
        )}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--zen-border)] px-4">
          <h2 className="flex-1 text-[14px] font-semibold">{title}</h2>
          {actions}
          <button
            type="button"
            className="zen-toolbar-button h-7 w-7"
            title="Close (Esc)"
            onClick={() => closeOverlay()}
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  )
}

export function EmptyNote({ children }: { children: ReactNode }): JSX.Element {
  return <p className="px-4 py-10 text-center text-[13px] text-[var(--zen-muted)]">{children}</p>
}
