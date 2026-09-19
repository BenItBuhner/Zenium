import type { JSX } from 'react'
import { useMemo } from 'react'
import type { UIState } from '@shared/types'
import { contentSettingsFor, type ContentDefault, type ContentSetting } from '@shared/contentSettings'
import { cmd, run } from '@renderer/lib/api'
import {
  SITE_SETTINGS_GROUPS,
  bySite,
  defaultDescription,
  defaultOptions,
  describeRule,
  hostOf,
  type SiteRules
} from '@renderer/lib/siteSettings'
import { V2Button } from '../v2/controls'
import { Card, EmptyRow, Group, Pane, Rows } from '../siteControls/pane'
import { ChoiceRow, ListRow } from '../siteControls/primitives'

/**
 * Settings > Site Settings on a mouse (design-language-v2-draft §9.13, §9.26, §9.27, §10.5):
 * every content type of the catalogue (`shared/contentSettings`) as a row with its default in a
 * menulist, grouped as Chrome groups them, and the sites that have answers of their own as a
 * card – the group has actions of its own – with a Reset that forgets each site
 * (`permissions.resetOrigin`) and Reset all. Defaults are the state's `permissionDefaults` and
 * go back through `permissions.setDefault`; the per-site list is the core's `permissionRules`.
 * The phone's rows are the Settings builder's (`siteControls/settingsRows.tsx`, the `sites-*`
 * groups of Privacy and Security).
 */
export function SiteSettingsSection({ state }: { state: UIState }): JSX.Element {
  const platform = state.platform === 'android' ? 'android' : 'desktop'
  const rows = useMemo(() => contentSettingsFor(platform), [platform])
  const sites = useMemo(() => bySite(state.permissionRules), [state.permissionRules])
  return (
    <Pane
      title="Site Settings"
      description="What sites may use and do. Sites ask first unless you decide for all of them here; a site you answered keeps that answer."
      data-testid="site-settings"
    >
      {SITE_SETTINGS_GROUPS.map((group) => {
        const own = rows.filter((r) => r.group === group.id)
        if (own.length === 0) return null
        return (
          <Group key={group.id} heading={group.heading} description={group.description}>
            <Rows>
              {own.map((setting) => (
                <ContentRow
                  key={setting.id}
                  setting={setting}
                  value={state.permissionDefaults[setting.id] ?? setting.builtInDefault}
                />
              ))}
            </Rows>
          </Group>
        )
      })}
      <DesktopSites sites={sites} />
    </Pane>
  )
}

/**
 * The site list (§10.5): a card, since the group has actions of its own – Reset all on the
 * heading's line and a hugging Reset trailing each site. The rows are not targets themselves
 * (`data-static`, §9.34): the button in each is.
 */
function DesktopSites({ sites }: { sites: SiteRules[] }): JSX.Element {
  return (
    <Group
      heading="Sites with their own settings"
      description="Answers you gave to a site's questions, and decisions made for a site in its information panel."
      trailing={
        sites.length > 0 ? (
          <V2Button
            onClick={() => run('permissions.reset', undefined)}
            aria-label="Reset the settings of every site"
          >
            Reset all
          </V2Button>
        ) : undefined
      }
      data-testid="site-settings-sites"
    >
      <Card className="px-0 py-1">
        {sites.length === 0 ? (
          <EmptyRow className="px-[var(--v2-card-padding)]">
            No site has settings of its own yet
          </EmptyRow>
        ) : (
          sites.map((site) => (
            <ListRow
              key={site.origin}
              label={hostOf(site.origin)}
              description={site.rules.map(describeRule).join(' · ')}
              control
              className="px-[var(--v2-card-padding)]"
              trailing={
                <V2Button
                  className="min-w-[88px]"
                  onClick={() => run('permissions.resetOrigin', { origin: site.origin })}
                  aria-label={`Reset the settings of ${hostOf(site.origin)}`}
                >
                  Reset
                </V2Button>
              }
            />
          ))
        )}
      </Card>
    </Group>
  )
}

function ContentRow({
  setting,
  value
}: {
  setting: ContentSetting
  value: ContentDefault
}): JSX.Element {
  return (
    <div data-content-setting={setting.id}>
      <ChoiceRow<ContentDefault>
        label={setting.label}
        description={defaultDescription(setting, value)}
        value={value}
        options={defaultOptions(setting)}
        onChange={(decision) =>
          void cmd('permissions.setDefault', { permission: setting.id, decision })
        }
      />
    </div>
  )
}
