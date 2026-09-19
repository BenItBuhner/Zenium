import type { JSX, ReactNode } from 'react'
import { useLayoutEffect, useRef, useState } from 'react'
import { KeyRound, ShieldCheck } from 'lucide-react'
import type { PermissionRule, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { describePermissionRule, siteLabel } from '@renderer/lib/security'
import { cn } from '@renderer/lib/utils'
import { V2Button, V2Card } from '../extensions/v2'

/**
 * Settings → Security on desktop. Every per-site answer Zenium remembered (pop-ups, hand-offs to
 * other apps, device, file and storage permissions) with a way to take it back, and the sign-ins
 * and certificate choices kept for this session. Built on the v2 draft (§6): the pane opens on
 * its 22/600 section title with 16 below it (§9.26) and flat cards with a hairline border where
 * a group has its own actions (`V2Card`, §9.27), 24 apart; inside a card the shared rows run
 * border to border with hairlines between them (§9.34, `.zen-v2-rows`), 32 px buttons, status in
 * ink only. The phone form is the `security` category of the Settings tab
 * (`pages/settings/sections.tsx`), built from the same state and commands.
 */
export function SecuritySection({ state }: { state: UIState }): JSX.Element {
  const rules = sortedRules(state.permissionRules)
  return (
    <div className="zen-v2 flex flex-col text-[var(--v2-text)]">
      <h2 className="mb-4 text-[length:var(--v2-font-title)] leading-[var(--v2-line-title)] font-semibold">
        Security
      </h2>
      <div className="flex flex-col gap-6">
        <V2Card title="Site permissions" icon={ShieldCheck}>
          <div className="zen-v2-rows">
            {rules.length === 0 ? (
              // An empty list (§9.17): one plain row, one sentence, no full stop.
              <StaticRow
                label={
                  <span className="zen-v2-deemphasized">No site permissions remembered yet</span>
                }
              />
            ) : (
              rules.map((rule) => (
                <StaticRow
                  key={`${rule.origin}|${rule.permission}`}
                  label={siteLabel(rule.origin)}
                  description={describePermissionRule(rule)}
                >
                  <span
                    className={cn(
                      'text-[length:var(--v2-font-small)] leading-[var(--v2-line-small)]',
                      rule.decision === 'allow'
                        ? 'text-[var(--v2-ok)]'
                        : 'text-[var(--v2-text-deemphasized)]'
                    )}
                  >
                    {rule.decision === 'allow' ? 'Allowed' : 'Blocked'}
                  </span>
                  <V2Button
                    onClick={() =>
                      run('permissions.forget', {
                        origin: rule.origin,
                        permission: rule.permission
                      })
                    }
                  >
                    Forget
                  </V2Button>
                </StaticRow>
              ))
            )}
            {/* The list's own action closes it, behind the hairline like any row (§9.34, §6). */}
            {rules.length > 1 && (
              <StaticRow
                label="Forget all site permissions"
                description="Every site asks again the next time it needs something."
              >
                <V2Button onClick={() => run('permissions.reset', undefined)}>Forget all</V2Button>
              </StaticRow>
            )}
          </div>
        </V2Card>
        <V2Card title="This session" icon={KeyRound}>
          <div className="zen-v2-rows">
            <StaticRow
              label="Sign-ins and certificates"
              description="Remembered until Zenium quits, in memory only"
            >
              <V2Button onClick={() => run('security.forgetSession', undefined)}>
                Forget now
              </V2Button>
            </StaticRow>
          </div>
        </V2Card>
      </div>
    </div>
  )
}

/**
 * A row that is not a target (§9.34): the shared `.zen-v2-row` for its geometry – 32 for one
 * line, 52 with a 13 px deemphasised description under the 15 px label, growing with its text –
 * carrying `data-static` (no hover or press fill, no pointer cursor, no role), with the shared
 * row anatomy inside it. Whatever trails the text – the status, the button that is the target –
 * centres on the row, except when the description has wrapped: on three text lines it centres on
 * the label's line instead (§9.18).
 */
function StaticRow({
  label,
  description,
  children
}: {
  label: ReactNode
  description?: string
  children?: ReactNode
}): JSX.Element {
  const text = useRef<HTMLSpanElement>(null)
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
    <div className="zen-v2-row" data-static="">
      <span className="zen-v2-row-body">
        <span ref={text} className="zen-v2-row-text">
          <span className="zen-v2-label truncate">{label}</span>
          {description && <span className="zen-v2-description">{description}</span>}
        </span>
      </span>
      {children && (
        <span
          className={cn(
            'flex shrink-0 items-center gap-3',
            wrapped && 'mt-[calc((var(--v2-line-body)-var(--v2-control))/2)] self-start'
          )}
        >
          {children}
        </span>
      )}
    </div>
  )
}

function sortedRules(rules: PermissionRule[]): PermissionRule[] {
  return [...rules].sort(
    (a, b) => a.origin.localeCompare(b.origin) || a.permission.localeCompare(b.permission)
  )
}
