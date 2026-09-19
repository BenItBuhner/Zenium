import type { JSX } from 'react'
import type { Settings, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { useChord } from '@renderer/lib/shortcuts'
import { Switch } from '../ui/switch'
import { DefaultBrowserSection } from './DefaultBrowserSection'
import { ResourcesSection } from './ResourcesSection'
import { Group, Row } from './SettingsPrimitives'
import { ShortcutsSection } from './ShortcutsSection'
import { SyncSection } from './SyncSection'

/**
 * The desktop's own Settings content (design language v2 §10.5): what the two-pane layout
 * (`pages/settings/desktop.tsx`) draws in its content column for a category the phone page
 * defines no rows for (`pages/settings/sections.tsx`) – Compact Mode, Resources, Sync, Keyboard
 * Shortcuts and Default Browser exist on the desktop alone. Every other category's rows come
 * from the section builders, in the desktop vocabulary; a category this host lacks, or one the
 * builders own, renders nothing here.
 */
export function SettingsBody({
  state,
  section
}: {
  state: UIState
  section: string
}): JSX.Element | null {
  const set = (patch: Partial<Settings>): void => run('settings.update', patch)
  switch (section) {
    case 'compact':
      return <CompactSection s={state.settings} set={set} />
    case 'resources':
      return state.capabilities.resourceGovernor ? (
        <ResourcesSection state={state} set={set} />
      ) : null
    case 'sync':
      return state.capabilities.sync ? <SyncSection state={state} /> : null
    case 'shortcuts':
      return <ShortcutsSection state={state} />
    case 'default-browser':
      return state.capabilities.defaultBrowser && state.platform !== 'android' ? (
        <DefaultBrowserSection state={state} />
      ) : null
    default:
      return null
  }
}

function CompactSection({
  s,
  set
}: {
  s: Settings
  set: (p: Partial<Settings>) => void
}): JSX.Element {
  const cm = s.compactMode
  const chord = useChord('compact.toggle')
  return (
    <Group title="Compact mode">
      <Row
        label="Enable compact mode"
        hint={`${chord ? `${chord}. ` : ''}Hidden bars reappear when you hover the window edge.`}
      >
        <Switch
          checked={cm.enabled}
          onCheckedChange={(v) => set({ compactMode: { ...cm, enabled: v } })}
        />
      </Row>
      <Row label="Hide sidebar">
        <Switch
          checked={cm.hideSidebar}
          onCheckedChange={(v) =>
            set({ compactMode: { ...cm, hideSidebar: v, hideToolbar: v ? cm.hideToolbar : true } })
          }
        />
      </Row>
      <Row
        label="Hide top toolbar"
        hint="Only applies to the Multiple / Collapsed toolbar layouts."
      >
        <Switch
          checked={cm.hideToolbar}
          disabled={s.toolbarLayout === 'single'}
          onCheckedChange={(v) =>
            set({ compactMode: { ...cm, hideToolbar: v, hideSidebar: v ? cm.hideSidebar : true } })
          }
        />
      </Row>
    </Group>
  )
}
