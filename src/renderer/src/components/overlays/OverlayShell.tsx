import { X } from 'lucide-react'
import type { ReactNode, JSX } from 'react'
import { useViewport } from '@renderer/lib/formFactor'
import { closeOverlay } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'

interface Props {
  title: string
  children: ReactNode
  /**
   * `dock` → left-docked panel; `dialog` → centred card; `full` → the content frame itself, the
   * way Zen's preferences are a page in the content area. On phones dock and full both fill it.
   */
  variant?: 'dock' | 'dialog' | 'full'
  actions?: ReactNode
  className?: string
}

/**
 * Common chrome for panels that open over the content area: a level-3 surface with a 44 header
 * (56 on phones) – title at the left, one trailing close button, no rule under it.
 */
export function OverlayShell({
  title,
  children,
  variant = 'dock',
  actions,
  className
}: Props): JSX.Element {
  const phone = useViewport().formFactor === 'phone'
  const fills = variant === 'full' || (variant === 'dock' && phone)
  return (
    <div className="absolute inset-0 z-30 flex" onMouseDown={() => closeOverlay()}>
      <div
        className={cn(
          'zen-panel zen-animate-in flex flex-col overflow-hidden',
          fills && 'zen-overlay-fill flex-1',
          variant === 'dock' && !phone && 'm-3 w-[380px] max-w-full',
          variant === 'dialog' &&
            (phone
              ? 'mx-2 mb-2 mt-auto w-auto max-h-[calc(100%-16px)]'
              : 'm-auto w-[560px] max-w-[calc(100%-32px)] max-h-[calc(100%-32px)]'),
          className
        )}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="zen-overlay-header">
          <h2 className="zen-overlay-title">{title}</h2>
          {actions}
          <button
            type="button"
            className="zen-toolbar-button"
            title="Close (Esc)"
            aria-label="Close"
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
