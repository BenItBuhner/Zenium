import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nativePromptPlan } from '../extensionPromptPlan'

/**
 * The native fallback prompt (`ext/ExtensionPromptFallback.kt` on `NativePromptSheet`) draws the
 * plan composed here: the same words as the renderer's `ExtensionPromptDialog`, the extension's
 * icon as the requester glyph, one row per warning with its kind's glyph, Cancel and the verb.
 */
describe('nativePromptPlan', () => {
  const icon = 'data:image/png;base64,iVBORw0KGgo='
  const warnings = [
    'Read and change all your data on all websites',
    'Read your browsing history',
    'Manage your downloads'
  ]

  it('composes an install prompt: the title with the name, the source, the icon, the rows, the verb', () => {
    const plan = nativePromptPlan({
      kind: 'install',
      name: 'Dark Reader',
      icon,
      warnings,
      source: 'chrome-web-store'
    })
    expect(plan).toEqual({
      title: 'Add "Dark Reader"?',
      description: 'From the Chrome Web Store',
      icon,
      caption: 'It can:',
      rows: [
        { glyph: 'globe', label: warnings[0], deemphasized: false },
        { glyph: 'history', label: warnings[1], deemphasized: false },
        { glyph: 'download', label: warnings[2], deemphasized: false }
      ],
      secondary: 'Cancel',
      primary: { label: 'Add extension', tone: 'accent' }
    })
  })

  it('says there is nothing to warn of as one deemphasised row without a caption', () => {
    const plan = nativePromptPlan({
      kind: 'install',
      name: 'Plain',
      icon: null,
      warnings: [],
      source: 'zip'
    })
    expect(plan.caption).toBeNull()
    expect(plan.description).toBe('From a ZIP file')
    expect(plan.icon).toBeNull()
    expect(plan.rows).toEqual([
      { glyph: null, label: 'This extension requires no special permissions', deemphasized: true }
    ])
    const request = nativePromptPlan({ kind: 'request', name: 'Plain', icon: null, warnings: [] })
    expect(request.rows[0].label).toBe('No new permissions are needed')
  })

  it('words an update, new permissions after an update and a runtime request as the renderer does', () => {
    const update = nativePromptPlan({
      kind: 'update',
      name: 'Bitwarden',
      icon,
      warnings,
      source: 'edge-add-ons'
    })
    expect(update.title).toBe('Update "Bitwarden"?')
    expect(update.description).toBe('From Edge Add-ons')
    expect(update.primary).toEqual({ label: 'Update extension', tone: 'accent' })
    const permissions = nativePromptPlan({ kind: 'permissions', name: 'Bitwarden', icon, warnings })
    expect(permissions.title).toBe('"Bitwarden" needs new permissions')
    expect(permissions.description).toBe('It was updated and stays off until you allow them')
    expect(permissions.primary.label).toBe('Allow')
    const request = nativePromptPlan({
      kind: 'request',
      name: 'Bitwarden',
      icon,
      warnings: [warnings[0]]
    })
    expect(request.title).toBe('"Bitwarden" wants additional permissions')
    expect(request.description).toBeNull()
    expect(request.primary.label).toBe('Allow')
    expect(request.secondary).toBe('Cancel')
  })

  it('names a glyph the Kotlin side has a drawable for, for every kind warningGlyph can pick', () => {
    const root = resolve(__dirname, '../../..')
    const union = readFileSync(
      resolve(root, 'src/renderer/src/lib/extensions/warningGlyph.ts'),
      'utf8'
    )
      .match(/export type WarningGlyph =([\s\S]*?)\n\n/)![1]
      .match(/'([a-z-]+)'/g)!
      .map((s) => s.slice(1, -1))
    expect(union.length).toBeGreaterThan(20)
    const drawables = readdirSync(resolve(root, 'android/app/src/main/res/drawable'))
      .filter((f) => f.startsWith('ic_warn_') && f.endsWith('.xml'))
      .map((f) => f.slice('ic_warn_'.length, -'.xml'.length).replace(/_/g, '-'))
      .sort()
    expect(drawables).toEqual([...union].sort())
    // And the Kotlin table that keeps the drawables through the resource shrinker names each one.
    const table = readFileSync(
      resolve(root, 'android/app/src/main/kotlin/app/zen/chromium/ext/ExtensionPromptFallback.kt'),
      'utf8'
    )
    for (const kind of union) {
      expect(table).toContain(`"${kind}" to R.drawable.ic_warn_${kind.replace(/-/g, '_')}`)
    }
  })
})
