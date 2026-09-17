import { describe, expect, it } from 'vitest'
import { buildExtensionBoot } from '../boot'
import { parseRuntimeManifest, type RuntimeManifest } from '../manifest'
import type { RegisteredContentScript } from '../plan'
import { injectsProgrammatically, originRulesFor, planUnits, sameUnits } from '../units'

const ID = 'abcdefghijklmnopabcdefghijklmnop'

function manifestOf(extra: Record<string, unknown>): RuntimeManifest {
  return parseRuntimeManifest(
    { manifest_version: 3, name: 'Unit test', version: '1.2.3', ...extra },
    null
  )
}

const env = { token: 't', uiLanguage: 'en', isolatedWorlds: true, userScriptMessaging: false }

describe('originRulesFor', () => {
  it('turns match patterns into origin rules and widens what the rule grammar cannot say', () => {
    expect([...originRulesFor(['*://*.youtube.com/*'])].sort()).toEqual([
      'http://*.youtube.com',
      'https://*.youtube.com'
    ])
    expect([...originRulesFor(['https://example.com:8443/path/*'])]).toEqual([
      'https://example.com:8443'
    ])
    expect([...originRulesFor(['<all_urls>'])]).toEqual(['*'])
    expect([...originRulesFor(['*://*/*'])]).toEqual(['*'])
    expect([...originRulesFor(['file:///*'])]).toEqual(['*'])
    expect([...originRulesFor([])]).toEqual(['*'])
    expect([...originRulesFor(['not a pattern'])]).toEqual(['*'])
  })
})

describe('planUnits', () => {
  it('makes one unit per world and origin rule set, in the extension worlds when the host has them', () => {
    const manifest = manifestOf({
      content_scripts: [
        { matches: ['*://*.youtube.com/*'], js: ['yt.js'], css: ['yt.css'] },
        { matches: ['*://*.youtube.com/*'], js: ['yt2.js'], run_at: 'document_start' },
        { matches: ['https://github.com/*'], js: ['gh.js'] },
        { matches: ['https://github.com/*'], js: ['gh-main.js'], world: 'MAIN' }
      ]
    })
    const boot = buildExtensionBoot(ID, manifest, null, [], 'world')
    const planned = planUnits(boot, manifest, env)
    expect(planned.id).toBe(ID)
    expect(planned.version).toBe('1.2.3')
    expect(planned.units.map((u) => u.key)).toEqual([
      'isolated:http://*.youtube.com https://*.youtube.com',
      'isolated:https://github.com',
      'main:https://github.com'
    ])
    const youtube = planned.units[0]
    expect(youtube.worldName).toBe(`zenium-ext-${ID}`)
    expect(youtube.isolation).toBe('world')
    expect(youtube.groups.map((g) => g.js)).toEqual([['yt.js'], ['yt2.js']])
    expect(youtube.css).toEqual([{ ext: ID, path: 'yt.css' }])
    expect(youtube.config.world).toBe('isolated')
    // The unit's own config carries only its groups, so a page compiles nothing it cannot run.
    expect(youtube.config.extension.groups.map((g) => g.js)).toEqual([['yt.js'], ['yt2.js']])
    const main = planned.units[2]
    expect(main.worldName).toBeNull()
    expect(main.isolation).toBe('none')
    expect(main.groups[0].isolation).toBe('none')
  })

  it('falls back to the with proxy in the main world without isolated worlds', () => {
    const manifest = manifestOf({
      content_scripts: [{ matches: ['https://github.com/*'], js: ['gh.js'] }]
    })
    const boot = buildExtensionBoot(ID, manifest, null, [], 'with')
    const planned = planUnits(boot, manifest, { ...env, isolatedWorlds: false })
    expect(planned.units).toHaveLength(1)
    expect(planned.units[0].worldName).toBeNull()
    expect(planned.units[0].isolation).toBe('with')
    expect(planned.units[0].config.extension.isolation).toBe('with')
  })

  it('adds a transport unit over the host permissions for programmatic injection, worlds only', () => {
    const manifest = manifestOf({
      permissions: ['scripting'],
      host_permissions: ['https://*.wikipedia.org/*', 'https://example.com/*'],
      content_scripts: [{ matches: ['https://example.com/*'], js: ['ex.js'] }]
    })
    const boot = buildExtensionBoot(ID, manifest, null, [], 'world')
    const planned = planUnits(boot, manifest, env)
    expect(planned.units.map((u) => u.key)).toEqual([
      'isolated:https://*.wikipedia.org',
      'isolated:https://example.com'
    ])
    expect(planned.units[0].groups).toEqual([])
    expect(planned.units[0].config.extension.groups).toEqual([])
    const without = planUnits(boot, manifest, { ...env, isolatedWorlds: false })
    expect(without.units.map((u) => u.key)).toEqual(['isolated:https://example.com'])
  })

  it('folds every unit of a world into the one that runs everywhere', () => {
    const manifest = manifestOf({
      permissions: ['scripting'],
      host_permissions: ['<all_urls>'],
      content_scripts: [
        { matches: ['https://example.com/*'], js: ['ex.js'] },
        { matches: ['<all_urls>'], js: ['all.js'] },
        { matches: ['https://example.com/*'], js: ['main.js'], world: 'MAIN' }
      ]
    })
    const boot = buildExtensionBoot(ID, manifest, null, [], 'world')
    const planned = planUnits(boot, manifest, env)
    expect(planned.units.map((u) => u.key)).toEqual(['isolated:*', 'main:https://example.com'])
    expect(planned.units[0].groups.map((g) => g.js)).toEqual([['ex.js'], ['all.js']])
  })

  it('gives user scripts their own world and carries the messaging switch', () => {
    const manifest = manifestOf({ permissions: ['userScripts'], host_permissions: ['<all_urls>'] })
    const registered: RegisteredContentScript[] = [
      {
        id: 'u1',
        persistAcrossSessions: true,
        matches: ['https://example.com/*'],
        excludeMatches: [],
        includeGlobs: [],
        excludeGlobs: [],
        js: ['user.js'],
        css: [],
        runAt: 'document_idle',
        allFrames: false,
        matchAboutBlank: false,
        matchOriginAsFallback: false,
        world: 'USER_SCRIPT'
      }
    ]
    const boot = buildExtensionBoot(ID, manifest, null, registered, 'world')
    const planned = planUnits(boot, manifest, { ...env, userScriptMessaging: true })
    const user = planned.units.find((u) => u.world === 'user')
    expect(user).toBeDefined()
    expect(user?.worldName).toBe(`zenium-ext-${ID}-user`)
    expect(user?.config.userScriptMessaging).toBe(true)
    // The scripting transport unit still covers every origin for executeScript.
    expect(planned.units.map((u) => u.key)).toEqual(['isolated:*', 'user:https://example.com'])
  })

  it('describes the served pages and the generated background page', () => {
    const manifest = manifestOf({
      background: { service_worker: 'sw.js', type: 'module' },
      web_accessible_resources: [{ resources: ['img/*.png'], matches: ['<all_urls>'] }]
    })
    const boot = buildExtensionBoot(ID, manifest, null, [], 'world')
    const planned = planUnits(boot, manifest, env)
    expect(planned.units).toEqual([])
    expect(planned.served.webAccessible).toEqual(['img/*.png'])
    expect(planned.served.backgroundUrl).toBe(
      `https://${ID}.ext.zenium.invalid/_generated_background_page.html`
    )
    expect(planned.served.backgroundHtml).toContain('<script type="module" src="/sw.js">')
    const page = JSON.parse(planned.served.page) as {
      kind: string
      extension: { groups: unknown[] }
    }
    expect(page.kind).toBe('page')
    expect(page.extension.groups).toEqual([])
  })

  it('uses the MV2 background page URL as is', () => {
    const manifest = parseRuntimeManifest(
      {
        manifest_version: 2,
        name: 'Old',
        version: '1',
        background: { page: 'bg.html', persistent: false }
      },
      null
    )
    const boot = buildExtensionBoot(ID, manifest, null, [], 'world')
    const planned = planUnits(boot, manifest, env)
    expect(planned.served.backgroundHtml).toBeNull()
    expect(planned.served.backgroundUrl).toBe(`https://${ID}.ext.zenium.invalid/bg.html`)
  })

  it('compares plans structurally so a no-op reconfigure never reaches the host', () => {
    const manifest = manifestOf({
      content_scripts: [{ matches: ['https://example.com/*'], js: ['ex.js'] }]
    })
    const boot = buildExtensionBoot(ID, manifest, null, [], 'world')
    const a = planUnits(boot, manifest, env)
    const b = planUnits(boot, manifest, env)
    expect(sameUnits(a, b)).toBe(true)
    expect(sameUnits(null, b)).toBe(false)
    const c = planUnits(boot, manifest, { ...env, uiLanguage: 'de' })
    expect(sameUnits(a, c)).toBe(false)
  })
})

describe('injectsProgrammatically', () => {
  it('recognises scripting, userScripts and MV2 host permissions', () => {
    expect(injectsProgrammatically(manifestOf({ permissions: ['scripting'] }))).toBe(true)
    expect(injectsProgrammatically(manifestOf({ permissions: ['userScripts'] }))).toBe(true)
    expect(injectsProgrammatically(manifestOf({ permissions: ['storage'] }))).toBe(false)
    expect(
      injectsProgrammatically(
        parseRuntimeManifest(
          { manifest_version: 2, name: 'Old', version: '1', permissions: ['https://*/*'] },
          null
        )
      )
    ).toBe(true)
  })
})
