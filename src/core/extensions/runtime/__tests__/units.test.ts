import { describe, expect, it } from 'vitest'
import { buildExtensionBoot } from '../boot'
import { parseRuntimeManifest, type RuntimeManifest } from '../manifest'
import type { RegisteredContentScript } from '../plan'
import {
  FOLD_ABOVE_UNITS,
  FOLD_UNIT_CHARS,
  foldFilesFor,
  injectsProgrammatically,
  mergeAlikeGroups,
  originRulesFor,
  planUnits,
  sameUnits
} from '../units'

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
    // Two rule sets in the extension's world: a holder of the bootstrap ahead of them (see below).
    expect(planned.units.map((u) => [u.key, u.shape])).toEqual([
      ['isolated:*', 'holder'],
      ['isolated:http://*.youtube.com https://*.youtube.com', 'thin'],
      ['isolated:https://github.com', 'thin'],
      ['main:https://github.com', 'whole']
    ])
    const youtube = planned.units[1]
    expect(youtube.worldName).toBe(`zenium-ext-${ID}`)
    expect(youtube.isolation).toBe('world')
    expect(youtube.groups.map((g) => g.js)).toEqual([['yt.js'], ['yt2.js']])
    expect(youtube.css).toEqual([{ ext: ID, path: 'yt.css' }])
    expect(youtube.config.world).toBe('isolated')
    // The unit's own config carries only its groups, so a page compiles nothing it cannot run.
    expect(youtube.config.extension.groups.map((g) => g.js)).toEqual([['yt.js'], ['yt2.js']])
    const main = planned.units[3]
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
    // The transport over wikipedia is a unit that runs there (thin: it boots through the
    // world's holder, which every frame gets), with no groups of its own.
    expect(planned.units.map((u) => [u.key, u.shape])).toEqual([
      ['isolated:*', 'holder'],
      ['isolated:https://*.wikipedia.org', 'thin'],
      ['isolated:https://example.com', 'thin']
    ])
    expect(planned.units[1].groups).toEqual([])
    expect(planned.units[1].config.extension.groups).toEqual([])
    const without = planUnits(boot, manifest, { ...env, isolatedWorlds: false })
    expect(without.units.map((u) => u.key)).toEqual(['isolated:https://example.com'])
  })

  it('folds only the sourceless units of a world into the one that runs everywhere', () => {
    // tl;dv's shape (compat round 18): a script for meet.google.com, one for
    // calendar.google.com and one for every page. Chrome hands a frame the scripts whose
    // patterns it matches alone; folded into the `<all_urls>` unit, the two host-bound scripts
    // (14.8 MB of the 20.7 MB) rode into every frame of every origin.
    const manifest = manifestOf({
      permissions: ['scripting'],
      host_permissions: ['<all_urls>'],
      content_scripts: [
        { matches: ['*://meet.google.com/*'], js: ['content-scripts/google-meet.js'] },
        { matches: ['*://calendar.google.com/*'], js: ['content-scripts/google-calendar.js'] },
        { matches: ['<all_urls>'], js: ['content-scripts/multi-tabs.js'] },
        { matches: ['https://example.com/*'], js: ['main.js'], world: 'MAIN' }
      ]
    })
    const boot = buildExtensionBoot(ID, manifest, null, [], 'world')
    const planned = planUnits(boot, manifest, env)
    expect(planned.units.map((u) => u.key)).toEqual([
      'isolated:*',
      'isolated:http://calendar.google.com https://calendar.google.com',
      'isolated:http://meet.google.com https://meet.google.com',
      'main:https://example.com'
    ])
    expect(planned.units.map((u) => u.groups.map((g) => g.js))).toEqual([
      [['content-scripts/multi-tabs.js']],
      [['content-scripts/google-calendar.js']],
      [['content-scripts/google-meet.js']],
      [['main.js']]
    ])
    // Each unit's config carries its own groups alone, so a Meet frame boots two copies of the
    // bootstrap (the everywhere unit's and its own) and compiles no calendar script.
    expect(planned.units[2].config.extension.groups.map((g) => g.js)).toEqual([
      ['content-scripts/google-meet.js']
    ])
    // The three isolated units share the extension's one world.
    expect(new Set(planned.units.slice(0, 3).map((u) => u.worldName)).size).toBe(1)
    // A unit without sources beside one over every origin is the fold's: the scripting transport
    // over the host permissions adds nothing next to `isolated:*`, and a CSS-only group keeps
    // its rules like a script (its text rides in the unit as well).
    const cssOnly = manifestOf({
      content_scripts: [
        { matches: ['https://example.com/*'], css: ['ex.css'] },
        { matches: ['<all_urls>'], js: ['all.js'] }
      ]
    })
    const cssBoot = buildExtensionBoot(ID, cssOnly, null, [], 'world')
    expect(planUnits(cssBoot, cssOnly, env).units.map((u) => u.key)).toEqual([
      'isolated:*',
      'isolated:https://example.com'
    ])
  })

  it('plans a main-world unit without sources over the externally connectable pages', () => {
    // Speak Subtitles for YouTube: its MAIN-world scripts on www.youtube.com reach the worker
    // through the page's own `chrome.runtime.sendMessage(<its id>, …)`.
    const manifest = manifestOf({
      externally_connectable: {
        matches: [
          'https://www.youtube.com/*',
          'https://*.example.org/*',
          '<all_urls>',
          '*://*/*',
          '*://*.com/*',
          'not a pattern',
          42
        ]
      },
      content_scripts: [
        { matches: ['https://www.youtube.com/*'], js: ['content.js'], world: 'MAIN' },
        { matches: ['https://github.com/*'], js: ['gh.js'] }
      ]
    })
    const boot = buildExtensionBoot(ID, manifest, null, [], 'world')
    expect(boot.externallyConnectable).toEqual([
      'https://www.youtube.com/*',
      'https://*.example.org/*'
    ])
    const planned = planUnits(boot, manifest, env)
    // www.youtube.com has the MAIN group's unit already, which carries the patterns: one copy
    // for both; example.org gets a unit without sources.
    expect(planned.units.map((u) => u.key)).toEqual([
      'isolated:https://github.com',
      'main:https://*.example.org',
      'main:https://www.youtube.com'
    ])
    const connectable = planned.units[1]
    expect(connectable.groups).toEqual([])
    expect(connectable.worldName).toBeNull()
    expect(connectable.isolation).toBe('none')
    expect(connectable.config.extension.externallyConnectable).toEqual(boot.externallyConnectable)
    expect(planned.units[2].groups.map((g) => g.js)).toEqual([['content.js']])
    expect(planned.units[2].config.extension.externallyConnectable).toEqual(
      boot.externallyConnectable
    )
    // Without worlds the unit is still the main world's own, not the `with` fallback's.
    const without = planUnits(boot, manifest, { ...env, isolatedWorlds: false })
    expect(without.units.find((u) => u.key === 'main:https://*.example.org')?.isolation).toBe(
      'none'
    )
    // A main-world unit over every origin covers the connectable pages too.
    const everywhere = manifestOf({
      externally_connectable: { matches: ['https://www.youtube.com/*'] },
      content_scripts: [{ matches: ['<all_urls>'], js: ['main.js'], world: 'MAIN' }]
    })
    const everywhereBoot = buildExtensionBoot(ID, everywhere, null, [], 'world')
    expect(planUnits(everywhereBoot, everywhere, env).units.map((u) => u.key)).toEqual(['main:*'])
    // Without the key no page gets the API, and nothing is planned for it.
    const plain = buildExtensionBoot(ID, manifestOf({}), null, [], 'world')
    expect(plain.externallyConnectable).toBeUndefined()
    expect(planUnits(plain, manifestOf({}), env).units).toEqual([])
    const idsOnly = manifestOf({ externally_connectable: { ids: ['*'] } })
    expect(buildExtensionBoot(ID, idsOnly, null, [], 'world').externallyConnectable).toBeUndefined()
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
    // The worker's page is served at the script's URL: `self.location` as in Chrome.
    expect(planned.served.backgroundUrl).toBe(`https://${ID}.ext.zenium.invalid/sw.js`)
    expect(planned.served.backgroundHtml).toContain('<script type="module" src="/sw.js">')
    const page = JSON.parse(planned.served.page) as {
      kind: string
      extension: { groups: unknown[] }
    }
    expect(page.kind).toBe('page')
    expect(page.extension.groups).toEqual([])
  })

  it('generates the MV2 background page at the path Chrome uses', () => {
    const manifest = parseRuntimeManifest(
      {
        manifest_version: 2,
        name: 'Old',
        version: '1',
        background: { scripts: ['a.js', 'b.js'], persistent: true }
      },
      null
    )
    const boot = buildExtensionBoot(ID, manifest, null, [], 'world')
    const planned = planUnits(boot, manifest, env)
    expect(planned.served.backgroundUrl).toBe(
      `https://${ID}.ext.zenium.invalid/_generated_background_page.html`
    )
    expect(planned.served.backgroundHtml).toContain(
      '<script src="/a.js"></script><script src="/b.js"></script>'
    )
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

  it('merges groups alike in everything but their patterns under the union, and no other', () => {
    // Grammarly's shape (compat round 19): the same two files listed under an Outlook set and a
    // classroom set, 2.67 M chars embedded twice; a third entry with the same files at
    // document_start is another kind, as is one with a different exclude list.
    const manifest = manifestOf({
      content_scripts: [
        {
          matches: ['https://*.outlook.live.com/*', 'https://*.outlook.office.com/*'],
          js: ['a.js', 'b.js']
        },
        { matches: ['https://*.nearpod.com/*'], js: ['a.js', 'b.js'] },
        { matches: ['https://*.nearpod.com/*'], js: ['a.js', 'b.js'], run_at: 'document_start' },
        {
          matches: ['https://*.overleaf.com/*'],
          js: ['a.js', 'b.js'],
          exclude_matches: ['https://*.overleaf.com/learn/*']
        },
        { matches: ['https://docs.google.com/*'], css: ['docs.css'] },
        { matches: ['https://sheets.google.com/*'], css: ['docs.css'] }
      ]
    })
    const boot = buildExtensionBoot(ID, manifest, null, [], 'world')
    // The boot orders its groups by run_at (the document_start entry first); read by index here.
    const merged = mergeAlikeGroups(boot.groups).sort((a, b) => a.index - b.index)
    expect(merged.map((g) => [g.index, g.matches])).toEqual([
      [
        0,
        [
          'https://*.outlook.live.com/*',
          'https://*.outlook.office.com/*',
          'https://*.nearpod.com/*'
        ]
      ],
      [2, ['https://*.nearpod.com/*']],
      [3, ['https://*.overleaf.com/*']],
      [4, ['https://docs.google.com/*', 'https://sheets.google.com/*']]
    ])
    // The boot record itself is left as the manifest had it.
    expect(boot.groups.find((g) => g.index === 0)?.matches).toEqual([
      'https://*.outlook.live.com/*',
      'https://*.outlook.office.com/*'
    ])
    expect(boot.groups).toHaveLength(6)
    // Planned: the merged group is one unit over the union's origins, its config naming the
    // merged patterns for the bootstrap's own matcher.
    const planned = planUnits(boot, manifest, { ...env, isolatedWorlds: false })
    const pair = planned.units.find((u) => u.groups.some((g) => g.index === 0))
    expect(pair?.origins).toEqual([
      'https://*.nearpod.com',
      'https://*.outlook.live.com',
      'https://*.outlook.office.com'
    ])
    expect(pair?.groups.map((g) => g.index)).toEqual([0])
    expect(pair?.config.extension.groups.map((g) => g.matches)).toEqual([
      ['https://*.outlook.live.com/*', 'https://*.outlook.office.com/*', 'https://*.nearpod.com/*']
    ])
    expect(planned.units.every((u) => u.shape === 'whole')).toBe(true)
  })

  it('gives an isolated world with several rule sets one bootstrap: the everywhere unit carries it, the others go thin', () => {
    const manifest = manifestOf({
      content_scripts: [
        { matches: ['<all_urls>'], js: ['all.js'] },
        { matches: ['https://docs.google.com/*'], js: ['docs.js'] },
        { matches: ['https://*.overleaf.com/*'], js: ['leaf.js'] },
        { matches: ['https://docs.google.com/*'], js: ['docs-main.js'], world: 'MAIN' },
        { matches: ['https://*.overleaf.com/*'], js: ['leaf-main.js'], world: 'MAIN' }
      ]
    })
    const boot = buildExtensionBoot(ID, manifest, null, [], 'world')
    const planned = planUnits(boot, manifest, env)
    expect(planned.units.map((u) => [u.key, u.shape])).toEqual([
      ['isolated:*', 'carrier'],
      ['isolated:https://*.overleaf.com', 'thin'],
      ['isolated:https://docs.google.com', 'thin'],
      // The main world is the page's: whole units, as before.
      ['main:https://*.overleaf.com', 'whole'],
      ['main:https://docs.google.com', 'whole']
    ])
    // Every unit still carries its own groups alone, under its own rules.
    expect(planned.units.map((u) => u.groups.map((g) => g.js))).toEqual([
      [['all.js']],
      [['leaf.js']],
      [['docs.js']],
      [['leaf-main.js']],
      [['docs-main.js']]
    ])
    // Without isolated worlds every unit is whole (the with proxy in the page's main world).
    const without = planUnits(boot, manifest, { ...env, isolatedWorlds: false })
    expect(without.units.every((u) => u.shape === 'whole')).toBe(true)
    // One rule set in the world: whole, no carrier wanted.
    const one = manifestOf({
      content_scripts: [{ matches: ['https://docs.google.com/*'], js: ['docs.js'] }]
    })
    expect(
      planUnits(buildExtensionBoot(ID, one, null, [], 'world'), one, env).units.map((u) => u.shape)
    ).toEqual(['whole'])
  })

  it('adds a holder over every origin where a world has several rule sets and none everywhere, first in order', () => {
    const manifest = manifestOf({
      content_scripts: [
        { matches: ['https://docs.google.com/*'], js: ['docs.js'] },
        { matches: ['https://*.overleaf.com/*'], js: ['leaf.js'] }
      ]
    })
    const boot = buildExtensionBoot(ID, manifest, null, [], 'world')
    const planned = planUnits(boot, manifest, env)
    expect(planned.units.map((u) => [u.key, u.shape, u.groups.length])).toEqual([
      ['isolated:*', 'holder', 0],
      ['isolated:https://*.overleaf.com', 'thin', 1],
      ['isolated:https://docs.google.com', 'thin', 1]
    ])
    const holder = planned.units[0]
    expect(holder.origins).toEqual(['*'])
    expect(holder.worldName).toBe(`zenium-ext-${ID}`)
    expect(holder.config.extension.groups).toEqual([])
    expect(holder.css).toEqual([])
    // The scripting transport over the host permissions is a unit that must run in its frames:
    // over every origin it is the carrier, not a holder.
    const scripting = manifestOf({
      permissions: ['scripting'],
      host_permissions: ['<all_urls>'],
      content_scripts: [
        { matches: ['https://docs.google.com/*'], js: ['docs.js'] },
        { matches: ['https://*.overleaf.com/*'], js: ['leaf.js'] }
      ]
    })
    const withTransport = planUnits(
      buildExtensionBoot(ID, scripting, null, [], 'world'),
      scripting,
      env
    )
    expect(withTransport.units.map((u) => [u.key, u.shape])).toEqual([
      ['isolated:*', 'carrier'],
      ['isolated:https://*.overleaf.com', 'thin'],
      ['isolated:https://docs.google.com', 'thin']
    ])
    expect(withTransport.units[0].groups).toEqual([])
  })

  /** Twelve hostname rule sets with a file each: what a uBO Lite fork registers, in small. */
  const SITES = Array.from({ length: 12 }, (_, i) => `s${String(i).padStart(2, '0')}`)
  const hostnameSets = (world?: 'MAIN'): Array<Record<string, unknown>> =>
    SITES.map((s) => ({
      matches: [`https://${s}.example/*`],
      js: [`${s}.js`],
      ...(world ? { world } : {})
    }))
  const sized = (chars: number, except: Record<string, number | null> = {}): Record<string, number> =>
    Object.fromEntries(
      SITES.flatMap((s) => {
        const own = except[`${s}.js`]
        return own === null ? [] : [[`${s}.js`, own ?? chars]]
      })
    )

  it("folds a world's many hostname units by the files' sizes, smallest first under the cap – the groups keep their own patterns (compat round 21)", () => {
    const manifest = manifestOf({ content_scripts: hostnameSets() })
    const boot = buildExtensionBoot(ID, manifest, null, [], 'with')
    const without = { ...env, isolatedWorlds: false }
    // Without the sizes nothing folds: the runtime asks the host for these files first.
    expect(planUnits(boot, manifest, without).units).toHaveLength(12)
    expect(foldFilesFor(boot, manifest, without)).toEqual(SITES.map((s) => `${s}.js`))
    // 100 K each: five to a bucket under the 512 K cap; equal sizes pack in key order.
    const planned = planUnits(boot, manifest, { ...without, fileChars: sized(100_000) })
    expect(planned.units.map((u) => [u.origins.length, u.groups.length, u.shape, u.isolation])).toEqual([
      [5, 5, 'whole', 'with'],
      [5, 5, 'whole', 'with'],
      [2, 2, 'whole', 'with']
    ])
    const first = planned.units[0]
    expect(first.key).toBe(
      'isolated:https://s00.example https://s01.example https://s02.example https://s03.example https://s04.example'
    )
    expect(first.worldName).toBeNull()
    // Each group still names its own pattern: the bootstrap runs it only where that matches.
    expect(first.config.extension.groups.map((g) => g.matches)).toEqual(
      SITES.slice(0, 5).map((s) => [`https://${s}.example/*`])
    )
    expect(first.groups.map((g) => g.js)).toEqual(SITES.slice(0, 5).map((s) => [`${s}.js`]))
    expect(planned.units[2].origins).toEqual(['https://s10.example', 'https://s11.example'])
    // The plan is stable: the same sizes make the same units.
    expect(sameUnits(planned, planUnits(boot, manifest, { ...without, fileChars: sized(100_000) }))).toBe(true)
    // Smallest first: the eleven 100 K files pack five, five and one, and the 300 K one joins
    // the bucket with room rather than opening its own.
    const uneven = planUnits(boot, manifest, {
      ...without,
      fileChars: sized(100_000, { 's00.js': 300_000 })
    })
    expect(uneven.units.map((u) => u.origins.length).sort()).toEqual([2, 5, 5])
    expect(uneven.units.find((u) => u.origins.length === 2)?.origins).toEqual([
      'https://s00.example',
      'https://s11.example'
    ])
  })

  it('leaves alone a unit over the cap, one the host could not size and a world under the count, and folds the main world only beside isolated worlds', () => {
    const manifest = manifestOf({ content_scripts: hostnameSets() })
    const boot = buildExtensionBoot(ID, manifest, null, [], 'with')
    const without = { ...env, isolatedWorlds: false }
    // tl;dv's shape (compat round 18): a unit over the cap alone is never folded; nor is one
    // naming a file the host did not size.
    const planned = planUnits(boot, manifest, {
      ...without,
      fileChars: sized(100_000, { 's00.js': FOLD_UNIT_CHARS + 1, 's01.js': null })
    })
    expect(planned.units.map((u) => [u.key.slice(0, 33), u.origins.length])).toEqual([
      ['isolated:https://s00.example', 1],
      ['isolated:https://s01.example', 1],
      ['isolated:https://s02.example http', 5],
      ['isolated:https://s07.example http', 5]
    ])
    // Up to the count nothing is weighed or asked for.
    const few = manifestOf({ content_scripts: hostnameSets().slice(0, FOLD_ABOVE_UNITS) })
    const fewBoot = buildExtensionBoot(ID, few, null, [], 'with')
    expect(foldFilesFor(fewBoot, few, without)).toBeNull()
    expect(planUnits(fewBoot, few, { ...without, fileChars: sized(100_000) }).units).toHaveLength(
      FOLD_ABOVE_UNITS
    )
    // With isolated worlds the extension's world goes thin (no bootstrap to save) and only the
    // main world's whole units fold.
    const both = manifestOf({ content_scripts: [...hostnameSets(), ...hostnameSets('MAIN')] })
    const bothBoot = buildExtensionBoot(ID, both, null, [], 'world')
    expect(foldFilesFor(bothBoot, both, env)).toEqual(SITES.map((s) => `${s}.js`))
    const worlds = planUnits(bothBoot, both, { ...env, fileChars: sized(100_000) })
    expect(worlds.units.filter((u) => u.world === 'isolated').map((u) => u.shape)).toEqual([
      'holder',
      ...Array<string>(12).fill('thin')
    ])
    expect(worlds.units.filter((u) => u.world === 'main').map((u) => [u.shape, u.origins.length])).toEqual([
      ['whole', 5],
      ['whole', 5],
      ['whole', 2]
    ])
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
