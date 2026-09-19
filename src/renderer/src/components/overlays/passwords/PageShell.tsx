import type { JSX, ReactNode, RefObject } from 'react'
import { useRef } from 'react'
import { ChevronLeft, X } from 'lucide-react'
import { useEscape } from '@renderer/hooks/useEscape'
import { useBackDismissal } from '@renderer/lib/back'
import { closeOverlay } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { usePhone } from './lib'
import { IconBtn, Title } from './shared'

/**
 * The manager's chassis: an in-content page on the neutral page surface filling the content
 * area (design language v2 §1, §3, §6), a page surface for the token families (§9.29), with the
 * overlay's back gesture – the page recedes towards the bottom edge under the finger – and a
 * click outside closing it. Panes stack inside. `layer` is the re-authentication prompt, a modal
 * that mounts itself in the frame's dialog host (`FrameDialogPortal`, lib/portals.tsx), over the
 * page and outside it: on the desktop the host's scrim dims the content frame only (§9.5) and
 * the dialog holds the keyboard (`usePopover`: Tab wraps inside it, Escape returns to what
 * asked); on a phone the prompt – like a menulist's picker sheet (§9.13) – is a sheet over this
 * page, a depth-two stack (§9.24): the sheet chassis owns the one scrim, holds the shell's
 * content, and this page in it, inert (`holdChromeInert`), and recedes the page under it on the
 * sheet's progress (passwords.css). Nothing here restates that: the layer closes first because
 * its Escape is the shared LIFO hook's, mounted after the page's own surfaces.
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
      // At rest the inline transform goes, so the stylesheet's recede under a sheet can take over.
      if (v <= 0) {
        el.style.transform = ''
        el.style.opacity = ''
        return
      }
      el.style.transform = `translateY(${30 * v}%) scale(${1 - 0.1 * v})`
      el.style.opacity = String(1 - v)
    },
    dismissed: () => closeOverlay()
  })
  return (
    <div
      className="zen-v2-pw absolute inset-0 z-30 flex"
      data-surface="page"
      onMouseDown={() => closeOverlay()}
    >
      <div
        ref={pageRef}
        role="dialog"
        aria-label="Passwords"
        className={cn(
          'zen-v2-pw-page zen-animate-in relative flex flex-1 flex-col overflow-hidden',
          phone ? 'm-2' : 'm-3',
          className
        )}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
      {/*
       * The layer renders elsewhere (a portal), but its events still bubble up the React tree:
       * a press inside the prompt must not read as a press outside the page.
       */}
      {layer && (
        <div className="contents" onMouseDown={(e) => e.stopPropagation()}>
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
      <div className="zen-v2-pw-header-row zen-v2-pw-column flex items-center gap-2">
        {onBack && (
          <IconBtn label="Back" onClick={onBack}>
            <ChevronLeft />
          </IconBtn>
        )}
        <div
          className={cn(
            'flex min-w-0 flex-1 items-center',
            !onBack && 'zen-v2-pw-header-title-lead'
          )}
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

/**
 * Registers a pane as a back surface (gesture and Escape) above whatever is under it: the
 * shared `useEscape` is a LIFO stack, so a prompt or a picker opened over the pane takes the
 * key first, the pane next, and the window's handler that closes the whole overlay last.
 */
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
  useEscape(onPop)
  return null
}
