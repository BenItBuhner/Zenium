import type { JSX, ReactNode } from 'react'

/**
 * The sticky page header (v2 draft §9.7): its content sits in the content column, the
 * hairline that appears once content scrolls under it runs across the whole page.
 */
export function PageHeader({
  scrolled,
  children
}: {
  scrolled: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <header className="zen-v2-header" data-scrolled={scrolled || undefined}>
      <div className="zen-v2-column zen-v2-header-row" data-bar="">
        {children}
      </div>
    </header>
  )
}
