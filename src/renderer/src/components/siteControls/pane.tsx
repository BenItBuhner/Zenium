import type { JSX, ReactNode } from 'react'
import { CircleAlert, CircleCheck, CircleHelp, Info, type LucideIcon } from 'lucide-react'
import type { SafetyState } from '@shared/types'
import { cn } from '@renderer/lib/utils'
import { V2_GLYPH } from '../v2/controls'
import { usePhone } from '@renderer/lib/surfaces'

/**
 * A Settings pane on the design language v2 draft, inside the interim overlay (§9.26, §9.27,
 * §10.3): on desktop a 22/600 section title at line-height 28 with an optional description 15
 * at 69% 4 px under it and 16 px to the first group; on a phone the chip strip names the pane,
 * so there is no 22 and the description opens the page. Groups are 15/600 sub-headings with
 * their description (15 at 69%) 4 under and the first row's box 8 below; groups sit 32 apart
 * (24 on a phone). Rows are the shared `ListRow` inside `Rows`, which lets their boxes run out into the
 * overlay's own padding so the labels share the heading's left edge; a card (§6) is flat, one
 * hairline, radius 8, 16 padding at both form factors, and desktop only where a group has its
 * own actions – a new phone group is rows under its heading (§9.17 as amended, §10.3).
 * Everything reads the page family: the overlay is a page surface.
 */
export function Pane({
  title,
  description,
  className,
  children,
  ...data
}: {
  title: string
  description?: ReactNode
  className?: string
  children: ReactNode
} & Record<`data-${string}`, string | undefined>): JSX.Element {
  const phone = usePhone()
  return (
    <div
      className={cn(
        'flex max-w-[var(--v2-content-max)] flex-col text-[15px] leading-5 text-[var(--v2-text)]',
        className
      )}
      data-surface="page"
      {...data}
    >
      {(!phone || description) && (
        // 16 from the title block's last line to the first group's box on desktop (§9.26), where
        // the groups then sit 32 apart; the phone keeps its 24 throughout.
        <div className={phone ? 'mb-6' : 'mb-4'}>
          {!phone && (
            <h2 className="text-[22px] leading-7 font-semibold tracking-[-0.01em]">{title}</h2>
          )}
          {description && (
            <p
              className={cn(
                'text-[15px] leading-5 text-[var(--v2-text-deemphasized)]',
                !phone && 'mt-1'
              )}
            >
              {description}
            </p>
          )}
        </div>
      )}
      <div className={cn('flex flex-col', phone ? 'gap-6' : 'gap-8')}>{children}</div>
    </div>
  )
}

/**
 * A group: a 15/600 sub-heading, its description 15 at 69% 4 under it (§4, §6: a sub-heading's
 * description is the page's, not a row's 13), the first row's box 8 below.
 */
export function Group({
  heading,
  description,
  trailing,
  children,
  className,
  ...data
}: {
  heading: string
  description?: ReactNode
  /** A control on the heading's line (a Reset all button), centred on it. */
  trailing?: ReactNode
  children: ReactNode
  className?: string
} & Record<`data-${string}`, string | undefined>): JSX.Element {
  return (
    <section className={cn('flex flex-col', className)} {...data}>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] leading-5 font-semibold">{heading}</h3>
          {description && (
            <p className="mt-1 text-[15px] leading-5 text-[var(--v2-text-deemphasized)]">
              {description}
            </p>
          )}
        </div>
        {trailing}
      </div>
      <div className="mt-2 flex flex-col">{children}</div>
    </section>
  )
}

/**
 * A card (§3, §6, §9.27): flat on `--v2-card` with one hairline at radius 8 and 16 padding; a
 * 17/600 title at line-height 22 with its glyph 8 before it names it from inside, the
 * description 15 at 69% under it. A card with a title has nothing above it.
 */
export function Card({
  glyph,
  title,
  description,
  action,
  children,
  className,
  ...data
}: {
  glyph?: ReactNode
  title?: ReactNode
  description?: ReactNode
  /** A button on the card's trailing side (desktop) or under its text (phone), §9.11. */
  action?: ReactNode
  children?: ReactNode
  className?: string
} & Record<`data-${string}`, string | undefined>): JSX.Element {
  const phone = usePhone()
  return (
    <section
      className={cn(
        'rounded-[var(--v2-radius-card)] border border-[var(--v2-card-border)] bg-[var(--v2-card)] p-[var(--v2-card-padding)]',
        className
      )}
      {...data}
    >
      {(title || description) && (
        // The glyph 8 before the title (§9.27); the action 8 after the text on desktop.
        <div className={cn('flex gap-2', phone ? 'flex-wrap items-start' : 'items-center')}>
          {glyph && (
            <span
              className="mt-[calc((22px-var(--v2-icon))/2)] flex shrink-0 self-start"
              aria-hidden
            >
              {glyph}
            </span>
          )}
          <div
            className={cn(
              'min-w-0 flex-1',
              phone && glyph && 'basis-[calc(100%-var(--v2-icon)-8px)]'
            )}
          >
            {title && (
              <div className="text-[17px] leading-[22px] font-semibold [font-variant-numeric:tabular-nums]">
                {title}
              </div>
            )}
            {description && (
              <div className="text-[15px] leading-5 text-[var(--v2-text-deemphasized)] [font-variant-numeric:tabular-nums]">
                {description}
              </div>
            )}
          </div>
          {action && (
            <div
              className={cn(
                'flex shrink-0 items-center',
                phone && glyph && 'ml-[calc(var(--v2-icon)+8px)]'
              )}
            >
              {action}
            </div>
          )}
        </div>
      )}
      {children}
    </section>
  )
}

/**
 * The rows of a group (§10.3: "gutter 16 everywhere, page edge to text; nothing inset
 * further"). `ListRow` insets its text 16 from its box; here the boxes reach out into the
 * overlay's padding by that inset – 12 on a phone, where the interim overlay pads 12, 16 on
 * desktop – so a label sits on the heading's left edge and the press fill runs past the text
 * on both sides, the way a settings list's rows do on every platform.
 */
export function Rows({
  children,
  className,
  ...data
}: { children: ReactNode; className?: string } & Record<
  `data-${string}`,
  string | undefined
>): JSX.Element {
  const phone = usePhone()
  return (
    <div
      className={cn(
        'flex flex-col',
        phone ? '-mx-3 [&_.zen-v2-row]:px-3' : '-mx-4 [&_.zen-v2-row]:px-4',
        className
      )}
      {...data}
    >
      {children}
    </div>
  )
}

/**
 * An empty state among rows or inside a card (§9.17 as amended): one plain row at the rows'
 * text edge or the card's own padding, 32 / 44 tall, the sentence 15 at 69% left-aligned like
 * a row's label, no top gap and no centring.
 */
export function EmptyRow({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <div
      className={cn(
        'flex min-h-[var(--v2-row)] items-center text-[15px] leading-5 text-[var(--v2-text-deemphasized)]',
        className
      )}
    >
      {children}
    </div>
  )
}

const STATUS_GLYPH: Record<SafetyState, LucideIcon> = {
  safe: CircleCheck,
  info: Info,
  warning: CircleAlert,
  unavailable: CircleHelp
}

/** A row's status glyph (§1 status ink, §9.3 row glyph): ok, an alert, an aside, or unknown. */
export function StatusGlyph({
  state,
  className
}: {
  state: SafetyState
  className?: string
}): JSX.Element {
  const Glyph = STATUS_GLYPH[state]
  return (
    <Glyph
      className={cn(
        V2_GLYPH,
        state === 'safe' && 'text-[var(--v2-ok)]',
        state === 'warning' && 'text-[var(--v2-warn)]',
        (state === 'info' || state === 'unavailable') && 'text-[var(--v2-text-deemphasized)]',
        className
      )}
      aria-hidden
    />
  )
}
