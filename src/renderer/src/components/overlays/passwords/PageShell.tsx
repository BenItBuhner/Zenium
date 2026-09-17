import type { JSX, ReactNode, RefObject } from 'react'
import { useRef } from 'react'
import { ChevronLeft, X } from 'lucide-react'
import { useBackDismissal } from '@renderer/lib/back'
import { closeOverlay } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { useEscape, usePhone } from './lib'
import { IconBtn, Title } from './shared'

/**
 * The manager's chassis: an in-content page on the neutral page surface filling the content
 * area (design language v2 §1, §3, §6), with the overlay's back gesture – the page recedes towards
 * the bottom edge under the finger – and a click outside closing it. Panes stack inside; `layer`
 * (the re-authentication prompt) sits over the whole content area, outside the page frame: a
 * desktop scrim dims the frame only (§9.5), while the phone sheet portals itself to the window,
 * where the shell's other sheets live.
 */
export function PageShell({
  children,
  layer,
  className
}: {
  children: ReactNode
  layer?: ReactNode
  className?: string
}): JSX.Element {
  const phone = usePhone()
  const pageRef = useRef<HTMLDivElement>(null)
  useBackDismissal('overlay', {
    travel: 360,
    render: (v) => {
      const el = pageRef.current
      if (!el) return
      el.style.transform = `translateY(${30 * v}%) scale(${1 - 0.1 * v})`
      el.style.opacity = String(1 - v)
    },
    dismissed: () => closeOverlay()
  })
  return (
    <div className="zen-v2-pw absolute inset-0 z-30 flex" onMouseDown={() => closeOverlay()}>
      <div
        ref={pageRef}
        role="dialog"
        aria-label="Passwords"
        style={{ transformOrigin: '50% 100%' }}
        className={cn(
          'zen-v2-pw-page zen-animate-in relative flex flex-1 flex-col overflow-hidden',
          phone ? 'm-2' : 'm-3',
          className
        )}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
      {layer && (
        <div className="absolute inset-0 z-10" onMouseDown={(e) => e.stopPropagation()}>
          {layer}
        </div>
      )}
    </div>
  )
}

/**
 * A pane header (§9.16): its control box plus 12 – 56 on a phone, 40 on the desktop – with a
 * 22/600 title, actions trailing, the close control on the page's own header and a back control
 * on a pushed pane. No line at rest; one appears at its bottom edge while content scrolls under
 * it, so the 16 px under the title (§9.7) belong to the scroller. Icon buttons overhang the
 * gutter so their glyphs sit on it.
 */
export function PaneHeader({
  title,
  onBack,
  onClose,
  actions,
  scrolled = false,
  children,
  className
}: {
  title: ReactNode
  onBack?: () => void
  onClose?: () => void
  actions?: ReactNode
  scrolled?: boolean
  /** A second header line (a search field) that stays above the scroller. */
  children?: ReactNode
  className?: string
}): JSX.Element {
  return (
    <header
      className={cn('zen-v2-pw-header flex shrink-0 flex-col gap-3', children && 'pb-3', className)}
      data-scrolled={scrolled}
    >
      <div
        className="zen-v2-pw-header-row zen-v2-pw-column flex items-center gap-2"
        style={{
          paddingLeft: 'calc(var(--pw-gutter) - (var(--v2-icon-button) - var(--v2-icon)) / 2)',
          paddingRight: 'calc(var(--pw-gutter) - (var(--v2-icon-button) - var(--v2-icon)) / 2)'
        }}
      >
        {onBack && (
          <IconBtn label="Back" onClick={onBack}>
            <ChevronLeft />
          </IconBtn>
        )}
        <div
          className="flex min-w-0 flex-1 items-center"
          style={
            onBack
              ? undefined
              : { paddingLeft: 'calc((var(--v2-icon-button) - var(--v2-icon)) / 2)' }
          }
        >
          {typeof title === 'string' ? <Title>{title}</Title> : title}
        </div>
        {actions}
        {onClose && (
          <IconBtn label="Close (Esc)" onClick={onClose}>
            <X />
          </IconBtn>
        )}
      </div>
      {children && <div className="zen-v2-pw-column zen-v2-pw-gutter">{children}</div>}
    </header>
  )
}

/**
 * A pane pushed over the page (a login, a form, the checkup, the settings). It is the surface
 * above the list: Escape and the system back gesture pop it first, the overlay itself only
 * afterwards; predictive back slides it off to the right with the finger.
 */
export function PushedPane({
  name,
  onPop,
  children,
  className
}: {
  name: string
  onPop: () => void
  children: ReactNode
  className?: string
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div
      ref={ref}
      className={cn('zen-v2-pw-pane absolute inset-0 z-[2] flex min-w-0 flex-col', className)}
    >
      <PaneBack name={name} paneRef={ref} onPop={onPop} />
      {children}
    </div>
  )
}

/** Registers a pane as a back surface (gesture and Escape) above whatever is under it. */
export function PaneBack({
  name,
  paneRef,
  onPop
}: {
  name: string
  paneRef: RefObject<HTMLDivElement | null>
  onPop: () => void
}): null {
  useBackDismissal(name, {
    travel: 320,
    render: (v) => {
      const el = paneRef.current
      if (!el) return
      el.style.transform = `translateX(${v * 100}%)`
      el.style.opacity = String(1 - v * 0.6)
    },
    dismissed: onPop
  })
  useEscape(name, onPop)
  return null
}
