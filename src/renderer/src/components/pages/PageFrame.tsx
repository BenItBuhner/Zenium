import type { JSX, KeyboardEvent, ReactNode, RefObject, UIEvent } from 'react'
import { useCallback, useState } from 'react'
import { Search, X } from 'lucide-react'
import { cn } from '@renderer/lib/utils'

/*
 * The frame of a chrome page tab that is a list – History, the bookmarks manager, Downloads
 * (design language v2 §10.1, the page family of §9.29): the page fills the content frame on
 * `--v2-page` with no header bar, no X and no panel chrome. Its column scrolls under a sticky
 * header that holds the page's 22/600 title block (§9.26, with the page's actions in its
 * trailing slot, §9.23) and, under it, the §9.12 search field; §9.7's hairline draws along the
 * header's bottom edge once the column has scrolled under it and goes again at the top. The
 * body is the Settings content column's geometry (§10.5, §5): the text column at most 664 wide
 * inside 32 side margins – the page's 16 plus the rows' own 16 gutter – left-aligned as Zen's,
 * so a row's hover fill runs 16 past its text on both sides and the title, the field, the group
 * headings and the rows' labels share one left edge at 32. Groups are §9.27 sub-headings (the
 * shared `.zen-v2-heading`, 15/600) over `.zen-v2-row` rows (§9.21); the empty state is §9.17's
 * one sentence. Every class here is layout: the controls are the `zen-v2-*` primitives.
 */

/**
 * The page: a flex column filling the host, its scroll container carrying `data-scrolled` while
 * the column is scrolled (the sticky header's hairline reads it). `header` is what stays put;
 * the children are the body.
 */
export function PageColumn({
  testId,
  className,
  header,
  scrollRef,
  onKeyDown,
  children
}: {
  testId?: string
  className?: string
  header: ReactNode
  scrollRef?: RefObject<HTMLDivElement | null>
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void
  children: ReactNode
}): JSX.Element {
  const [scrolled, setScrolled] = useState(false)
  const onScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    setScrolled(e.currentTarget.scrollTop > 0)
  }, [])
  return (
    <div className={cn('zen-page', className)} data-testid={testId} onKeyDown={onKeyDown}>
      <div
        ref={scrollRef}
        className="zen-page-scroll"
        data-scrolled={scrolled || undefined}
        onScroll={onScroll}
      >
        <header className="zen-page-header">{header}</header>
        <div className="zen-page-body">{children}</div>
      </div>
    </div>
  )
}

/**
 * The title block (§9.26, §10.2): the page's name 22/600 on its 28 line, padding 16 16 12, an
 * optional description 15 at 69% 4 under it, and the page's actions – `zen-v2-button`
 * secondaries – in the trailing slot on the title's line (§9.23). The name is the page's `h1`.
 */
export function PageTitleBlock({
  title,
  description,
  actions,
  titleId
}: {
  title: string
  description?: ReactNode
  actions?: ReactNode
  titleId?: string
}): JSX.Element {
  return (
    <div className="zen-page-title-block">
      <div className="zen-page-title-row">
        <h1 id={titleId} className="zen-page-title">
          {title}
        </h1>
        {actions && <div className="zen-page-title-actions">{actions}</div>}
      </div>
      {description && <p className="zen-page-title-desc">{description}</p>}
    </div>
  )
}

/**
 * The page's search field (§9.12, as "Find in Settings" draws it): the 32 px `--v2-field` with
 * its 16 px glyph and, while there is a query, the clear icon button. Escape clears the query,
 * and with none to clear leaves the field (the focus returns to the page), so a second Escape
 * is the chrome's again.
 */
export function PageSearchField({
  value,
  onChange,
  placeholder,
  label = placeholder,
  field,
  testId,
  autoFocus = false
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  label?: string
  field?: RefObject<HTMLInputElement | null>
  testId?: string
  autoFocus?: boolean
}): JSX.Element {
  return (
    <div className="zen-page-search">
      <Search className="zen-page-search-glyph" aria-hidden="true" />
      <input
        ref={field}
        type="text"
        role="searchbox"
        className="zen-v2-field zen-page-search-field"
        data-testid={testId}
        placeholder={placeholder}
        aria-label={label}
        inputMode="search"
        enterKeyHint="search"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return
          e.preventDefault()
          e.stopPropagation()
          if (value) onChange('')
          else e.currentTarget.blur()
        }}
      />
      {value && (
        <button
          type="button"
          className="zen-page-search-clear zen-v2-icon-button"
          aria-label="Clear search"
          onClick={() => {
            onChange('')
            field?.current?.focus()
          }}
        >
          <X aria-hidden="true" />
        </button>
      )}
    </div>
  )
}

/**
 * A group on the page (§9.27, §10.3): the shared 15/600 heading with an optional aside (a count,
 * 13 at 69% tabular) and an optional trailing control (a §9.3 icon button whose 28 box does not
 * grow the heading's 20 line), then its rows. The section is named by its heading.
 */
export function PageGroup({
  heading,
  aside,
  control,
  headingId,
  className,
  children,
  ...data
}: {
  heading: ReactNode
  aside?: ReactNode
  control?: ReactNode
  headingId?: string
  className?: string
  children: ReactNode
} & Record<`data-${string}`, string | number | boolean | undefined>): JSX.Element {
  return (
    <section className={cn('zen-page-group', className)} aria-labelledby={headingId} {...data}>
      <div className="zen-v2-heading zen-page-heading">
        <h2 id={headingId} className="zen-page-heading-text">
          {heading}
        </h2>
        {aside !== undefined && aside !== null && (
          <span className="zen-page-heading-aside">{aside}</span>
        )}
        {control}
      </div>
      {children}
    </section>
  )
}

/**
 * The page's empty state (§9.17): one sentence, sentence case, no full stop, 15/400 at 69%,
 * centred in a 32 gutter, its line 32 under the header; an optional single follow-up 16 beneath
 * it – a secondary button – only where there is one obvious next step.
 */
export function PageEmpty({
  children,
  action,
  testId
}: {
  children: ReactNode
  action?: ReactNode
  testId?: string
}): JSX.Element {
  return (
    <div className="zen-page-empty" role="status" data-testid={testId}>
      <p>{children}</p>
      {action && <div className="zen-page-empty-action">{action}</div>}
    </div>
  )
}
