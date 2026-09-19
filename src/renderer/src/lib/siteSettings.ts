import type { PermissionRule } from '@shared/types'
import {
  contentSetting,
  contentSettingId,
  contentSettingsFor,
  type ContentDefault,
  type ContentSetting
} from '@shared/contentSettings'
import { permissionLabel } from '@shared/siteInfo'
import type { MenulistOption } from '@renderer/components/siteControls/primitives'

/**
 * The words and orderings of Settings > Site settings (`components/overlays/SiteSettingsSection`):
 * what a content type's default menulist offers and means, and how the sites with answers of
 * their own line up.
 */

const WORDS: Record<ContentDefault, string> = { ask: 'Ask', allow: 'Allow', deny: 'Block' }

/**
 * What the menulist offers: the catalogue's choices for the row (Chrome offers no "allow every
 * site" for the camera), the built-in one marked "(default)".
 */
export function defaultOptions(setting: ContentSetting): MenulistOption<ContentDefault>[] {
  return setting.choices.map((value) => ({
    value,
    label: value === setting.builtInDefault ? `${WORDS[value]} (default)` : WORDS[value]
  }))
}

/** What the row says its current default means: the catalogue's line for the built-in, else plain words. */
export function defaultDescription(setting: ContentSetting, value: ContentDefault): string {
  if (value === setting.builtInDefault) return setting.description
  const subject = setting.label.toLowerCase()
  switch (value) {
    case 'ask':
      return `Sites can ask to use ${subject}`
    case 'allow':
      return `Sites can use ${subject} without asking`
    default:
      return `Sites cannot use ${subject}`
  }
}

export interface SiteRules {
  origin: string
  rules: PermissionRule[]
}

/** Rules grouped by site, sites alphabetically, each site's rows in the catalogue's order. */
export function bySite(rules: PermissionRule[]): SiteRules[] {
  const map = new Map<string, PermissionRule[]>()
  for (const rule of rules) {
    const list = map.get(rule.origin) ?? []
    list.push(rule)
    map.set(rule.origin, list)
  }
  return [...map.entries()]
    .sort(([a], [b]) => hostOf(a).localeCompare(hostOf(b)))
    .map(([origin, own]) => ({
      origin,
      rules: own.sort((a, b) => order(a.permission) - order(b.permission))
    }))
}

function order(permission: string): number {
  const id = contentSettingId(permission)
  const at = contentSettingsFor('desktop', ['enforced', 'stored', 'n-a']).findIndex(
    (s) => s.id === id
  )
  return at === -1 ? Number.MAX_SAFE_INTEGER : at
}

/** "Camera: allowed", "Pop-ups: blocked" (a qualified rule names its target: "Open zoommtg links: allowed"). */
export function describeRule(rule: PermissionRule): string {
  const label = contentSetting(rule.permission)?.label ?? permissionLabel(rule.permission)
  return `${label}: ${rule.decision === 'allow' ? 'allowed' : 'blocked'}`
}

export function hostOf(origin: string): string {
  try {
    return new URL(origin).host || origin
  } catch {
    return origin
  }
}

/** Figures in a sentence: "1,284 visits", "12 sites". */
export function count(n: number, unit: string, plural = `${unit}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? unit : plural}`
}
