import type { JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import type { SafetyCheckResult, UIState } from '@shared/types'
import { cmd, run } from '@renderer/lib/api'
import {
  headline,
  safetyRows,
  worstState,
  type SafetyAction,
  type SafetyRow
} from '@renderer/lib/safetyCheck'
import { uiStore } from '@renderer/lib/ui'
import { cn, relativeTime } from '@renderer/lib/utils'
import { V2_GLYPH, V2Button } from '../v2/controls'
import { Card, EmptyRow, Group, Pane, Rows, StatusGlyph } from '../siteControls/pane'
import { usePhone } from '@renderer/lib/surfaces'
import { BusyButton, ListRow } from '../siteControls/primitives'
import type { SettingsSection } from './SettingsPanel'

/**
 * Settings > Safety Check (design-language-v2-draft §6, §9.2, §9.18, §9.21, §9.27, §10.3,
 * §10.4): the check's standing – when it last ran and how it went – with Check now, and one row
 * per area from `privacy.safetyCheck`: Updates, Safe Browsing, Passwords, Permissions,
 * Notifications and Extensions, each a status glyph in the §1 status ink, the engine's sentence,
 * and where there is something to do, the action that answers it (download the update, review
 * the sites, check the passwords, open the extensions). On desktop the standing is a card with
 * its button and each row's action a hugging button trailing it; on a phone there are no cards
 * and no inline buttons: a status row, a Check now action row, and result rows that are the
 * action themselves, a chevron on those that leave the pane. The check runs once when the pane
 * opens and again on demand.
 */
export function SafetyCheckSection({
  state,
  setSection
}: {
  state: UIState
  setSection: (id: SettingsSection) => void
}): JSX.Element {
  const { result, running, error, check } = useSafetyCheck()
  const phone = usePhone()
  const rows = result ? safetyRows(result, state) : []
  const worst = result ? worstState(result) : null
  const act = (action: SafetyAction): void => {
    switch (action.kind) {
      case 'command':
        run(action.command, undefined)
        break
      case 'passwords-checkup':
        run('passwords.checkupRun', undefined)
        // The checkup reports through the passwords status; read the check again once it has.
        setTimeout(check, 1500)
        break
      case 'section':
        if (action.section === 'extensions') uiStore.set({ overlaySection: 'extensions' })
        setSection(action.section)
        break
    }
  }
  const glyph =
    result && worst ? (
      <StatusGlyph state={worst} />
    ) : (
      <ShieldCheck className={cn(V2_GLYPH, 'text-[var(--v2-text-deemphasized)]')} aria-hidden />
    )
  const title = headline(result, running, error, worst)
  const when = result
    ? `Checked ${relativeTime(result.checkedAt).toLowerCase()}`
    : 'Not checked yet'
  return (
    <Pane
      title="Safety Check"
      description="Zenium looks for an update, checks Safe Browsing, your saved passwords, the permissions and notifications sites hold, and your extensions."
      data-testid="safety-check"
    >
      {phone ? (
        <Rows data-state={worst ?? undefined} data-testid="safety-check-standing">
          <ListRow label={title} description={when} leading={glyph} />
          <ListRow
            label="Check now"
            onClick={check}
            busy={running}
            data-testid="safety-check-now"
          />
        </Rows>
      ) : (
        <Card
          glyph={glyph}
          title={title}
          description={when}
          action={
            <BusyButton busy={running} onClick={check} data-testid="safety-check-now">
              Check now
            </BusyButton>
          }
          data-state={worst ?? undefined}
          data-testid="safety-check-standing"
        />
      )}

      <Group
        heading="Results"
        description="Each row is one area; an action takes you where something can be done."
      >
        <Rows>
          {rows.length === 0 && !running && !result && (
            <EmptyRow>{error ?? 'Run the check to see results'}</EmptyRow>
          )}
          {rows.length === 0 && running && <EmptyRow>Checking…</EmptyRow>}
          {rows.map((row) => {
            const action = row.action
            return phone ? (
              <ListRow
                key={row.id}
                label={row.label}
                description={row.summary}
                leading={<StatusGlyph state={row.state} />}
                onClick={action ? () => act(action.act) : undefined}
                chevron={action?.act.kind === 'section'}
                data-safety-row={row.id}
                data-state={row.state}
              />
            ) : (
              <ListRow
                key={row.id}
                label={row.label}
                description={row.summary}
                leading={<StatusGlyph state={row.state} />}
                control={action !== null}
                trailing={action ? <RowAction row={row} onAct={act} /> : undefined}
                data-safety-row={row.id}
                data-state={row.state}
              />
            )
          })}
        </Rows>
      </Group>
    </Pane>
  )
}

function RowAction({
  row,
  onAct
}: {
  row: SafetyRow
  onAct: (action: SafetyAction) => void
}): JSX.Element | null {
  if (!row.action) return null
  const { label, ariaLabel, act } = row.action
  return (
    <V2Button className="min-w-[88px]" onClick={() => onAct(act)} aria-label={ariaLabel}>
      {label}
    </V2Button>
  )
}

/**
 * One `privacy.safetyCheck` reading per run: the first when the pane opens, another on Check
 * now. A run that ends after the pane closed is dropped.
 */
function useSafetyCheck(): {
  result: SafetyCheckResult | null
  running: boolean
  error: string | null
  check: () => void
} {
  const [result, setResult] = useState<SafetyCheckResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [run, setRun] = useState<{ id: number; running: boolean }>({ id: 0, running: true })
  useEffect(() => {
    let alive = true
    cmd('privacy.safetyCheck', undefined).then(
      (r) => {
        if (!alive) return
        setResult(r)
        setError(null)
        setRun((current) => (current.id === run.id ? { ...current, running: false } : current))
      },
      (e: unknown) => {
        if (!alive) return
        setError(e instanceof Error ? e.message : 'Safety check could not run')
        setRun((current) => (current.id === run.id ? { ...current, running: false } : current))
      }
    )
    return () => {
      alive = false
    }
  }, [run.id])
  const check = useCallback((): void => {
    setRun((current) => ({ id: current.id + 1, running: true }))
  }, [])
  return { result, running: run.running, error, check }
}
