import type { JSX } from 'react'
import type { Settings, UIState } from '@shared/types'
import { activeTab } from '@renderer/lib/selectors'
import { openOverlay } from '@renderer/lib/ui'
import { Button } from '../ui/button'
import { Switch } from '../ui/switch'
import { PASSWORD_GRACE_OPTIONS, PASSWORDS_COPY, passwordsSavedLabel } from './settingsCopy'
import { Choice, Group, Row } from './SettingsPrimitives'

/**
 * Settings > Passwords on the desktop panel: the way into the password manager and the two
 * preferences that are settings rather than vault operations. Protection, import and export live
 * in the manager's settings view, behind its re-authentication. The phone says the same in its
 * Settings tab (`pages/settings/sections.tsx`, `passwordsSection`), from the same copy.
 */
export function PasswordsSection({
  state,
  set
}: {
  state: UIState
  set: (patch: Partial<Settings>) => void
}): JSX.Element {
  const s = state.settings.passwords
  return (
    <>
      <Group title="Password manager">
        <Row label="Saved passwords" hint={passwordsSavedLabel(state.passwords)}>
          <Button onClick={() => void openOverlay('passwords', activeTab(state)?.id ?? null)}>
            Open password manager
          </Button>
        </Row>
      </Group>
      <Group title="Saving">
        <Row label={PASSWORDS_COPY.offerToSave.label} hint={PASSWORDS_COPY.offerToSave.description}>
          <Switch
            checked={s.offerToSave}
            onCheckedChange={(v) => set({ passwords: { ...s, offerToSave: v } })}
          />
        </Row>
      </Group>
      <Group title="Security">
        <Row label={PASSWORDS_COPY.grace.label} hint={PASSWORDS_COPY.grace.description}>
          <Choice
            value={String(s.reauthGraceSeconds)}
            onChange={(v) => set({ passwords: { ...s, reauthGraceSeconds: Number(v) } })}
            options={PASSWORD_GRACE_OPTIONS}
          />
        </Row>
      </Group>
    </>
  )
}
