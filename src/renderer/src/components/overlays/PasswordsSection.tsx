import type { JSX } from 'react'
import type { Settings, UIState } from '@shared/types'
import { activeTab } from '@renderer/lib/selectors'
import { openOverlay } from '@renderer/lib/ui'
import { Button } from '../ui/button'
import { Switch } from '../ui/switch'
import { Choice, Group, Row } from './SettingsPrimitives'

const GRACE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '0', label: 'Every time' },
  { value: '30', label: 'After 30 seconds' },
  { value: '60', label: 'After 1 minute' },
  { value: '300', label: 'After 5 minutes' },
  { value: '900', label: 'After 15 minutes' },
  { value: '3600', label: 'After 1 hour' }
]

/**
 * Settings > Passwords, on the Settings panel's own primitives: the way into the password
 * manager and the two preferences that are settings rather than vault operations. Protection,
 * import and export live in the manager's settings view, behind its re-authentication.
 */
export function PasswordsSection({
  state,
  set
}: {
  state: UIState
  set: (patch: Partial<Settings>) => void
}): JSX.Element {
  const status = state.passwords
  const s = state.settings.passwords
  const saved = !status.locked
    ? `${status.count} ${status.count === 1 ? 'login' : 'logins'} saved`
    : status.protection.os || status.protection.passphrase
      ? 'The vault is locked'
      : 'No vault yet'
  return (
    <>
      <Group title="Password manager">
        <Row label="Saved passwords" hint={saved}>
          <Button onClick={() => void openOverlay('passwords', activeTab(state)?.id ?? null)}>
            Open password manager
          </Button>
        </Row>
      </Group>
      <Group title="Saving">
        <Row
          label="Offer to save passwords"
          hint="Ask to save logins typed into websites. The prompt itself arrives with in-page filling."
        >
          <Switch
            checked={s.offerToSave}
            onCheckedChange={(v) => set({ passwords: { ...s, offerToSave: v } })}
          />
        </Row>
      </Group>
      <Group title="Security">
        <Row
          label="Ask again before showing or copying"
          hint="How long one verification covers reveals, copies and exports."
        >
          <Choice
            value={String(s.reauthGraceSeconds)}
            onChange={(v) => set({ passwords: { ...s, reauthGraceSeconds: Number(v) } })}
            options={GRACE_OPTIONS}
          />
        </Row>
      </Group>
    </>
  )
}
