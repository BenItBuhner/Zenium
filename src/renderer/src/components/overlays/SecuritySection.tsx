import type { JSX } from 'react'
import { KeyRound, ShieldCheck } from 'lucide-react'
import type { PermissionRule, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { describePermissionRule, siteLabel } from '@renderer/lib/security'
import { cn } from '@renderer/lib/utils'
import { Button } from '../ui/button'
import { Group, Row } from './SettingsPrimitives'

/**
 * Settings → Security. Every per-site answer Zenium remembered (pop-ups, hand-offs to other
 * apps, device, file and storage permissions) with a way to take it back, and the sign-ins and
 * certificate choices kept for this session.
 */
export function SecuritySection({ state }: { state: UIState }): JSX.Element {
  const rules = sortedRules(state.permissionRules)
  return (
    <>
      <Group title="Site permissions">
        {rules.length === 0 ? (
          <Row
            label="Nothing remembered yet"
            hint="When you answer a permission prompt or let a site open pop-ups, the decision is kept here until you forget it."
          >
            <ShieldCheck className="h-4 w-4 text-[var(--zen-muted)]" />
          </Row>
        ) : (
          rules.map((rule) => (
            <Row
              key={`${rule.origin}|${rule.permission}`}
              label={siteLabel(rule.origin)}
              hint={describePermissionRule(rule)}
            >
              <span
                className={cn(
                  'text-[11.5px]',
                  rule.decision === 'allow' ? 'text-[var(--zen-accent)]' : 'text-[var(--zen-muted)]'
                )}
              >
                {rule.decision === 'allow' ? 'Allowed' : 'Blocked'}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  run('permissions.forget', { origin: rule.origin, permission: rule.permission })
                }
              >
                Forget
              </Button>
            </Row>
          ))
        )}
        {rules.length > 1 && (
          <Row
            label="Forget all site permissions"
            hint="Every site asks again the next time it needs something."
          >
            <Button
              variant="secondary"
              size="sm"
              onClick={() => run('permissions.reset', undefined)}
            >
              Forget all
            </Button>
          </Row>
        )}
      </Group>
      <Group title="This session">
        <Row
          label="HTTP sign-ins and certificate choices"
          hint="Usernames, passwords and client certificates you asked Zenium to remember are kept in memory only and go away when it quits."
        >
          <KeyRound className="h-4 w-4 text-[var(--zen-muted)]" />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => run('security.forgetSession', undefined)}
          >
            Forget now
          </Button>
        </Row>
      </Group>
    </>
  )
}

function sortedRules(rules: PermissionRule[]): PermissionRule[] {
  return [...rules].sort(
    (a, b) => a.origin.localeCompare(b.origin) || a.permission.localeCompare(b.permission)
  )
}
