import type { JSX, ReactNode } from 'react'
import { useLayoutEffect, useRef, useState } from 'react'
import { KeyRound, ShieldCheck } from 'lucide-react'
import type { PermissionRule, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { viewportStore } from '@renderer/lib/formFactor'
import { describePermissionRule, siteLabel } from '@renderer/lib/security'
import { cn } from '@renderer/lib/utils'
import { V2_GLYPH, V2Button } from '../v2/controls'

/**
 * Settings → Security. Every per-site answer Zenium remembered (pop-ups, hand-offs to other
 * apps, device, file and storage permissions) with a way to take it back, and the sign-ins and
 * certificate choices kept for this session. Built on the v2 draft (§6): on desktop the pane
 * opens on its 22/600 section title with 16 below it (§9.26) and flat cards with a hairline
 * border where a group has its own actions, 24 apart; on a phone there is no 22 below the bar
 * that names the page and no card (§10.3) – groups under 15/600 headings, 20 apart. Two-line
 * rows, 32 / 40 px buttons, status in ink only.
 */
export function SecuritySection({ state }: { state: UIState }): JSX.Element {
  const phone = viewportStore.use((s) => s.formFactor === 'phone')
  const rules = sortedRules(state.permissionRules)
  return (
    <div className="flex flex-col text-[var(--v2-text)]">
      {!phone && <h2 className="mb-4 text-[22px] leading-7 font-semibold">Security</h2>}
      <div className={cn('flex flex-col', phone ? 'gap-5' : 'gap-6')}>
        <Group
          phone={phone}
          icon={<ShieldCheck className={V2_GLYPH} aria-hidden />}
          title="Site permissions"
          footer={
            rules.length > 1 && (
              <CardRow
                label="Forget all site permissions"
                description="Every site asks again the next time it needs something."
              >
                <V2Button onClick={() => run('permissions.reset', undefined)}>Forget all</V2Button>
              </CardRow>
            )
          }
        >
          {rules.length === 0 ? (
            <Empty phone={phone}>No site permissions remembered yet</Empty>
          ) : (
            rules.map((rule) => (
              <CardRow
                key={`${rule.origin}|${rule.permission}`}
                label={siteLabel(rule.origin)}
                description={describePermissionRule(rule)}
              >
                <span
                  className={cn(
                    'text-[13px] leading-5',
                    rule.decision === 'allow'
                      ? 'text-[var(--v2-ok)]'
                      : 'text-[var(--v2-text-deemphasized)]'
                  )}
                >
                  {rule.decision === 'allow' ? 'Allowed' : 'Blocked'}
                </span>
                <V2Button
                  onClick={() =>
                    run('permissions.forget', { origin: rule.origin, permission: rule.permission })
                  }
                >
                  Forget
                </V2Button>
              </CardRow>
            ))
          )}
        </Group>
        <Group
          phone={phone}
          icon={<KeyRound className={V2_GLYPH} aria-hidden />}
          title="This session"
        >
          <CardRow
            label="Sign-ins and certificates"
            description="Remembered until Zenium quits, in memory only"
          >
            <V2Button onClick={() => run('security.forgetSession', undefined)}>Forget now</V2Button>
          </CardRow>
        </Group>
      </div>
    </div>
  )
}

/**
 * A group of rows with its own actions. Desktop: a flat card (§6, §9.27) – 8 px radius, 1 px
 * border, 16 px padding – named by the 17/600 title at line-height 22 (§4) inside it with its
 * 16 px glyph 8 px before, and nothing above it; the rows carry their own padding and touch
 * (§9.21) and a footer action sits 12 under them, the card's edge being the only line (§0, §3).
 * Phone: no card, border or fill (§10.3) – a 15/600 heading at line-height 20 with 4 below it
 * (the 20 above is the list's gap; the first sits under the bar at the shell's own padding),
 * then the rows edge to edge and 0 apart, the footer action simply the last of them.
 */
function Group({
  phone,
  icon,
  title,
  children,
  footer
}: {
  phone: boolean
  icon: JSX.Element
  title: string
  children: ReactNode
  footer?: ReactNode
}): JSX.Element {
  if (phone) {
    return (
      <section className="flex flex-col">
        <h3 className="mb-1 text-[15px] leading-5 font-semibold">{title}</h3>
        {children}
        {footer}
      </section>
    )
  }
  return (
    <section className="rounded-[var(--v2-radius-card)] border border-[var(--v2-card-border)] bg-[var(--v2-card)] p-4">
      <h3 className="flex items-center gap-2 text-[17px] leading-[22px] font-semibold">
        {icon}
        {title}
      </h3>
      <div className="mt-2 flex flex-col">{children}</div>
      {footer && <div className="mt-3">{footer}</div>}
    </section>
  )
}

/**
 * An empty list (§9.17). Inside the desktop card it is one plain row at the card's own padding:
 * 32 tall, the sentence 15 at 69% left-aligned like a row's label, no top gap and no centring.
 * On a phone, where the group is a list under a heading, it is the one centred sentence in a
 * 32 px gutter with its first line 48 below the heading, top-anchored.
 */
function Empty({ phone, children }: { phone: boolean; children: ReactNode }): JSX.Element {
  return (
    <p
      className={cn(
        'text-[15px] leading-5 text-[var(--v2-text-deemphasized)]',
        phone ? 'px-5 pt-11 pb-2 text-center' : 'flex min-h-[var(--v2-row)] items-center'
      )}
    >
      {children}
    </p>
  )
}

/**
 * A two-line row (§9.2): 15 px label over a 13 px deemphasised description on 20 px lines, with
 * 6 px of padding (12 on phones) for 52 / 64, growing with its text; the description wraps to
 * two lines at most. Trailing controls are centred on the row, except when the description has
 * wrapped: on three text lines they centre on the label's line instead (§9.18).
 */
function CardRow({
  label,
  description,
  children
}: {
  label: string
  description: string
  children?: ReactNode
}): JSX.Element {
  const text = useRef<HTMLDivElement>(null)
  const [wrapped, setWrapped] = useState(false)
  useLayoutEffect(() => {
    const el = text.current
    if (!el) return
    // Two 20 px lines are the row's own; anything taller is a wrapped description.
    const measure = (): void => setWrapped(el.getBoundingClientRect().height > 50)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return (
    <div className="flex min-h-[var(--v2-row-two-line)] items-center gap-4 py-[calc((var(--v2-row-two-line)-40px)/2)]">
      <div ref={text} className="min-w-0 flex-1">
        <div className="truncate text-[15px] leading-5">{label}</div>
        <div className="line-clamp-2 text-[13px] leading-5 text-[var(--v2-text-deemphasized)]">
          {description}
        </div>
      </div>
      {children && (
        <div
          className={cn(
            'flex shrink-0 items-center gap-3',
            wrapped && 'self-start mt-[calc((20px-var(--v2-control))/2)]'
          )}
        >
          {children}
        </div>
      )}
    </div>
  )
}

function sortedRules(rules: PermissionRule[]): PermissionRule[] {
  return [...rules].sort(
    (a, b) => a.origin.localeCompare(b.origin) || a.permission.localeCompare(b.permission)
  )
}
