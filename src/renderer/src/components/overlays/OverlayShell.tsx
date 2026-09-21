import { X } from 'lucide-react'
import type { ReactNode, JSX } from 'react'
import { useCallback, useRef } from 'react'
import { useBackDismissal } from '@renderer/lib/back'
import { useFadeEdges } from '@renderer/hooks/useFadeEdges'
import { useViewport } from '@renderer/lib/formFactor'
import { closeOverlay } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { useScrolled } from '../bookmarks/popover'

interface Props {
  title: string
  children: ReactNode
  /** `dock` → left-docked sidebar panel; `dialog` → centred card; `full` → fills the content area. */
  variant?: 'dock' | 'dialog' | 'full'
  actions?: ReactNode
  className?: string
  /** Stable hook for the desktop boot smoke (`data-testid` on the panel). */
  testId?: string
  /** Stands in for the default header (a phone panel's 56 header, or its selection header). */
  header?: ReactNode
  /**
   * The shell scrolls the children (default). Off, the children fill the panel as a column and
   * scroll whatever part of themselves they want to – a list under a pinned search field.
   */
  scroll?: boolean
}

/** Common chrome for panels that open over the content area. */
export function OverlayShell({
  title,
  children,
  variant = 'dock',
  actions,
  className,
  testId,
  header,
  scroll = true
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
  // The header marks content scrolled under it with the §9.7 hairline (`data-scrolled`), so the
  // body fades its end edge only; the ref is shared between the fade and the scroll watcher.
  const bodyRef = useRef<HTMLDivElement>(null)
  const fade = useFadeEdges<HTMLDivElement>({ axis: 'y', edges: 'end' })
  const scrolled = useScrolled(bodyRef)
  const attachBody = useCallback(
    (el: HTMLDivElement | null) => {
      bodyRef.current = el
      return fade(el)
    },
    [fade]
  )
  return (
    <div className="absolute inset-0 z-30 flex" onMouseDown={() => closeOverlay()}>
      {/* A panel is a page surface (design language v2 §9.29): its controls draw in the page family. */}
      <div
        ref={panelRef}
        data-surface="page"
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
        {header ?? (
          // The overlay header (§9.7): the title 22/600 on a page (`full`) or 17/600 on a panel,
          // no line at rest, 16 from the title's line box to the first content box; the hairline
          // at its bottom edge only while the body is scrolled under it. On a phone it is the
          // §9.16 bar header, 56 tall with the 44 close at a 6 margin. The close is the §9.3
          // icon button, named for the screen reader without the keyboard hint a tooltip carries
          // on a phone (§9.31).
          <header
            className="zen-overlay-header"
            data-size={variant === 'full' ? 'page' : 'panel'}
            data-scrolled={scrolled || undefined}
          >
            <h2 className="zen-overlay-title">{title}</h2>
            {actions}
            <button
              type="button"
              className="zen-v2-icon-button"
              title={phone ? undefined : 'Close (Esc)'}
              aria-label="Close"
              onClick={() => closeOverlay()}
            >
              <X aria-hidden />
            </button>
          </header>
        )}
        {scroll ? (
          <div ref={attachBody} className="min-h-0 flex-1 overflow-y-auto">
            {children}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        )}
      </div>
    </div>
  )
}

export function EmptyNote({ children }: { children: ReactNode }): JSX.Element {
  return <p className="px-4 py-10 text-center text-[13px] text-[var(--zen-muted)]">{children}</p>
}
