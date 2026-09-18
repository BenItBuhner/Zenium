import { X } from 'lucide-react'
import type { ReactNode, JSX } from 'react'
import { useRef } from 'react'
import { useBackDismissal } from '@renderer/lib/back'
import { useFadeEdges } from '@renderer/hooks/useFadeEdges'
import { useViewport } from '@renderer/lib/formFactor'
import { closeOverlay } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'

interface Props {
  title: string
  children: ReactNode
  /** `dock` → left-docked sidebar panel; `dialog` → centred card; `full` → fills the content area. */
  variant?: 'dock' | 'dialog' | 'full'
  actions?: ReactNode
  className?: string
  /** Stable hook for the desktop boot smoke (`data-testid` on the panel). */
  testId?: string
}

/** Common chrome for panels that open over the content area. */
export function OverlayShell({
  title,
  children,
  variant = 'dock',
  actions,
  className,
  testId
}: Props): JSX.Element {
  const phone = useViewport().formFactor === 'phone'
  // The system back gesture: the panel recedes towards the bottom edge, shrinking and fading
  // with the finger; commit closes it, cancel springs it back.
  const panelRef = useRef<HTMLDivElement>(null)
  useBackDismissal('overlay', {
    travel: 360,
    render: (v) => {
      const el = panelRef.current
      if (!el) return
      el.style.transform = `translateY(${30 * v}%) scale(${1 - 0.1 * v})`
      el.style.opacity = String(1 - v)
    },
    dismissed: () => closeOverlay()
  })
  const fade = useFadeEdges<HTMLDivElement>({ axis: 'y' })
  return (
    <div className="absolute inset-0 z-30 flex" onMouseDown={() => closeOverlay()}>
      <div
        ref={panelRef}
        style={{ transformOrigin: '50% 100%' }}
        className={cn(
          'zen-panel zen-animate-in flex flex-col overflow-hidden',
          // Docked panels take the whole content card on phones; dialogs hug the bottom edge.
          variant === 'dock' && (phone ? 'm-2 flex-1' : 'm-3 w-[380px] max-w-full'),
          variant === 'dialog' &&
            (phone
              ? 'mx-2 mb-2 mt-auto w-auto max-h-[calc(100%-16px)]'
              : 'm-auto w-[560px] max-w-[calc(100%-32px)] max-h-[calc(100%-32px)]'),
          variant === 'full' && (phone ? 'm-2 flex-1' : 'm-3 flex-1'),
          className
        )}
        data-testid={testId}
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
        <div ref={fade} className="min-h-0 flex-1 overflow-y-auto">
          {children}
        </div>
      </div>
    </div>
  )
}

export function EmptyNote({ children }: { children: ReactNode }): JSX.Element {
  return <p className="px-4 py-10 text-center text-[13px] text-[var(--zen-muted)]">{children}</p>
}
