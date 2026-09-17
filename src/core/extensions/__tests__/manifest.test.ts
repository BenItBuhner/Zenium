import { describe, expect, it } from 'vitest'
import {
  buildMessageCatalog,
  compareVersions,
  expandPlaceholders,
  isMatchPattern,
  isValidExtensionVersion,
  localeFallbackChain,
  localizeManifest,
  parseManifest,
  parseVersion,
  satisfiesMinimumChromeVersion,
  stripJsonComments,
  substituteMessages,
  validateManifest,
  type ManifestIssue
} from '../manifest'

const paths = (issues: ManifestIssue[]): string[] => issues.map((i) => i.path)

const mv3 = {
  manifest_version: 3,
  name: 'Sample',
  version: '1.2.3',
  description: 'A sample',
  icons: { '16': 'i16.png', '128': 'i128.png' },
  permissions: ['storage', 'declarativeNetRequest'],
  host_permissions: ['https://*.example.com/*'],
  background: { service_worker: 'sw.js', type: 'module' },
  action: { default_popup: 'popup.html', default_icon: { '16': 'a16.png' } },
  content_scripts: [
    { matches: ['<all_urls>'], js: ['cs.js'], run_at: 'document_idle', world: 'MAIN' }
  ],
  options_ui: { page: 'options.html', open_in_tab: true },
  web_accessible_resources: [{ resources: ['img/*.png'], matches: ['https://example.com/*'] }],
  declarative_net_request: { rule_resources: [{ id: 'rules', enabled: true, path: 'rules.json' }] },
  default_locale: 'en',
  minimum_chrome_version: '120',
  update_url: 'https://clients2.google.com/service/update2/crx',
  commands: { toggle: { suggested_key: { default: 'Ctrl+Shift+Y' }, description: 'Toggle' } },
  incognito: 'split',
  content_security_policy: { extension_pages: "script-src 'self'" },
  homepage_url: 'https://example.com'
}

const mv2 = {
  manifest_version: 2,
  name: 'Legacy',
  version: '0.9',
  background: { scripts: ['bg.js'], persistent: false },
  browser_action: { default_title: 'Legacy', default_icon: 'icon.png' },
  web_accessible_resources: ['img/*.png'],
  content_security_policy: "script-src 'self'; object-src 'self'",
  permissions: ['tabs', 'https://*/*'],
  options_page: 'options.html'
}

describe('validateManifest', () => {
  it('accepts a full MV3 manifest', () => {
    const result = validateManifest(mv3)
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.manifest?.manifest_version).toBe(3)
    expect(result.manifest?.background?.service_worker).toBe('sw.js')
  })

  it('accepts a full MV2 manifest', () => {
    const result = validateManifest(mv2)
    expect(result.errors).toEqual([])
    expect(result.manifest?.browser_action?.default_title).toBe('Legacy')
  })

  it('requires the core keys and a sane manifest_version', () => {
    expect(paths(validateManifest({}).errors).sort()).toEqual([
      'manifest_version',
      'name',
      'version'
    ])
    expect(
      paths(validateManifest({ manifest_version: 1, name: 'x', version: '1' }).errors)
    ).toEqual(['manifest_version'])
    expect(
      paths(validateManifest({ manifest_version: '3', name: 'x', version: '1' }).errors)
    ).toEqual(['manifest_version'])
    expect(validateManifest(null).errors[0].message).toMatch(/JSON object/)
    expect(validateManifest([]).errors).toHaveLength(1)
    expect(paths(validateManifest({ manifest_version: 3, name: '', version: '1' }).errors)).toEqual(
      ['name']
    )
    expect(
      paths(validateManifest({ manifest_version: 3, name: 'x', version: 'a.b' }).errors)
    ).toEqual(['version'])
  })

  it('enforces the MV3 background and action rules', () => {
    const scripts = validateManifest({ ...mv3, background: { scripts: ['bg.js'] } })
    expect(paths(scripts.errors).sort()).toEqual([
      'background.scripts',
      'background.service_worker'
    ])
    // Cross-browser manifests: ignored, not rejected, next to a service worker.
    const both = validateManifest({
      ...mv3,
      background: { scripts: ['bg.js'], service_worker: 'bg.js' }
    })
    expect(both.errors).toEqual([])
    expect(paths(both.warnings)).toEqual(['background.scripts'])
    expect(paths(validateManifest({ ...mv3, browser_action: {} }).errors)).toEqual([
      'browser_action'
    ])
    expect(paths(validateManifest({ ...mv2, action: {} }).errors)).toEqual(['action'])
    expect(paths(validateManifest({ ...mv2, page_action: {} }).errors)).toEqual(['page_action'])
    expect(
      paths(validateManifest({ ...mv2, background: { scripts: ['a'], page: 'b.html' } }).errors)
    ).toEqual(['background'])
    expect(paths(validateManifest({ ...mv2, background: {} }).errors)).toEqual(['background'])
  })

  it('checks both shapes of web_accessible_resources and content_security_policy', () => {
    expect(paths(validateManifest({ ...mv3, web_accessible_resources: ['a.png'] }).errors)).toEqual(
      ['web_accessible_resources[0]']
    )
    expect(
      paths(validateManifest({ ...mv3, web_accessible_resources: [{ resources: ['a'] }] }).errors)
    ).toEqual(['web_accessible_resources[0]'])
    expect(
      paths(
        validateManifest({
          ...mv3,
          web_accessible_resources: [{ resources: [], matches: ['<all_urls>'] }]
        }).errors
      )
    ).toEqual(['web_accessible_resources[0].resources'])
    expect(
      paths(validateManifest({ ...mv2, web_accessible_resources: [{ resources: ['a'] }] }).errors)
    ).toEqual(['web_accessible_resources[0]'])
    expect(
      paths(validateManifest({ ...mv3, content_security_policy: 'script-src' }).errors)
    ).toEqual(['content_security_policy'])
    expect(
      paths(validateManifest({ ...mv2, content_security_policy: { extension_pages: 'x' } }).errors)
    ).toEqual(['content_security_policy'])
  })

  it('validates content scripts and match patterns', () => {
    const bad = validateManifest({
      ...mv3,
      content_scripts: [
        { js: ['a.js'] },
        { matches: ['notapattern'], css: ['a.css'], run_at: 'now' },
        { matches: ['https://a.com/*'] }
      ]
    })
    expect(paths(bad.errors).sort()).toEqual([
      'content_scripts[0].matches',
      'content_scripts[1].matches[0]',
      'content_scripts[1].run_at',
      'content_scripts[2]'
    ])
    expect(
      paths(
        validateManifest({
          ...mv2,
          content_scripts: [{ matches: ['<all_urls>'], js: ['a'], world: 'MAIN' }]
        }).errors
      )
    ).toEqual(['content_scripts[0].world'])
  })

  it('validates declarative_net_request rulesets and their permission', () => {
    const noPermission = validateManifest({ ...mv3, permissions: ['storage'] })
    expect(paths(noPermission.errors)).toEqual(['declarative_net_request'])
    const dupes = validateManifest({
      ...mv3,
      declarative_net_request: {
        rule_resources: [
          { id: 'a', enabled: true, path: 'a.json' },
          { id: 'a', enabled: 'yes', path: 'b.json' },
          { id: 'c', path: 'c.json' }
        ]
      }
    })
    expect(paths(dupes.errors).sort()).toEqual([
      'declarative_net_request.rule_resources[1].enabled',
      'declarative_net_request.rule_resources[1].id',
      'declarative_net_request.rule_resources[2].enabled'
    ])
  })

  it('validates misc keys: locale, urls, key, commands, incognito, overrides', () => {
    const result = validateManifest({
      ...mv3,
      default_locale: 'not a locale!',
      minimum_chrome_version: 'abc',
      update_url: 'ftp://example.com/x',
      homepage_url: 'nope',
      key: '@@@',
      commands: { noDescription: { suggested_key: 'Ctrl+K' }, _execute_action: {} },
      incognito: 'maybe',
      chrome_url_overrides: { newtab: 'a.html', history: 'b.html', foo: 'c.html' },
      omnibox: {},
      externally_connectable: { matches: ['bad'] }
    })
    expect(paths(result.errors).sort()).toEqual([
      'chrome_url_overrides',
      'chrome_url_overrides.foo',
      'commands.noDescription.description',
      'default_locale',
      'externally_connectable.matches[0]',
      'homepage_url',
      'incognito',
      'key',
      'minimum_chrome_version',
      'omnibox.keyword',
      'update_url'
    ])
  })

  it('warns about unknown keys, MV2 host_permissions, long names and _execute_browser_action in MV3', () => {
    const result = validateManifest({
      ...mv3,
      name: 'x'.repeat(80),
      made_up_key: true,
      commands: { _execute_browser_action: { suggested_key: 'Ctrl+B' } }
    })
    expect(result.errors).toEqual([])
    expect(paths(result.warnings).sort()).toEqual([
      'commands._execute_browser_action',
      'made_up_key',
      'name'
    ])
    const legacy = validateManifest({ ...mv2, host_permissions: ['<all_urls>'] })
    expect(paths(legacy.warnings)).toEqual(['host_permissions'])
  })

  it('requires default_locale when __MSG__ references are used', () => {
    const result = validateManifest({ manifest_version: 3, name: '__MSG_name__', version: '1' })
    expect(paths(result.errors)).toEqual(['default_locale'])
    const ok = validateManifest({
      manifest_version: 3,
      name: '__MSG_name__',
      version: '1',
      default_locale: 'en'
    })
    expect(ok.errors).toEqual([])
  })
})

describe('parseManifest', () => {
  it('strips comments and a BOM, and reports JSON errors', () => {
    const text =
      '\uFEFF{\n // comment with "quotes" and http://url\n "manifest_version": 3, /* block */ "name": "A // not a comment",\n "version": "1"\n}'
    const result = parseManifest(text)
    expect(result.errors).toEqual([])
    expect(result.manifest?.name).toBe('A // not a comment')
    expect(parseManifest('{').errors[0].message).toMatch(/not valid JSON/)
    expect(stripJsonComments('"a\\"b" // c')).toBe('"a\\"b" ')
    expect(stripJsonComments('/* unterminated')).toBe('')
  })
})

describe('versions', () => {
  it('parses Chrome-style version strings', () => {
    expect(parseVersion('1')).toEqual([1])
    expect(parseVersion('1.0.2.65535')).toEqual([1, 0, 2, 65535])
    expect(parseVersion('1.02')).toEqual([1, 2]) // leading zeros are only rejected in the first component
    expect(parseVersion('01.0')).toBeNull()
    expect(parseVersion('1.2.3.4.5')).toBeNull()
    expect(parseVersion('1.2.3.4.5', 5)).toEqual([1, 2, 3, 4, 5])
    expect(parseVersion('1.-2')).toBeNull()
    expect(parseVersion('1..2')).toBeNull()
    expect(parseVersion('1.a')).toBeNull()
    expect(parseVersion('')).toBeNull()
    expect(parseVersion('4294967296')).toBeNull()
    expect(isValidExtensionVersion('2026.914.1325')).toBe(true)
  })

  it('compares numerically with zero padding', () => {
    expect(compareVersions('1.0', '1')).toBe(0)
    expect(compareVersions('1.0.0.1', '1')).toBe(1)
    expect(compareVersions('1.10', '1.9')).toBe(1)
    expect(compareVersions('2026.914.1325', '2026.1000.1')).toBe(-1)
    expect(compareVersions('152.0.7590.12', '152.0.7590.12')).toBe(0)
    expect(() => compareVersions('x', '1')).toThrow(/Invalid version/)
    expect(satisfiesMinimumChromeVersion({ minimum_chrome_version: '120' }, '152.0.0.0')).toBe(true)
    expect(satisfiesMinimumChromeVersion({ minimum_chrome_version: '153.1' }, '152.0.0.0')).toBe(
      false
    )
    expect(satisfiesMinimumChromeVersion({}, '1')).toBe(true)
  })
})

describe('isMatchPattern', () => {
  it('accepts Chrome match patterns and rejects the rest', () => {
    for (const ok of [
      '<all_urls>',
      'https://*/*',
      '*://*.example.com/',
      'http://127.0.0.1/*',
      'https://example.com:8080/path*',
      'file:///foo*',
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop/*',
      'https://[::1]/*'
    ]) {
      expect(isMatchPattern(ok), ok).toBe(true)
    }
    for (const bad of [
      'https://www.google.com', // no path
      'https://*foo/bar',
      'https://foo.*.bar/baz',
      'http:/bar',
      'foo://*',
      'https:///path',
      '*.example.com/*'
    ]) {
      expect(isMatchPattern(bad), bad).toBe(false)
    }
  })
})

describe('localisation', () => {
  it('builds Chrome fallback chains', () => {
    expect(localeFallbackChain('pt-BR', 'en')).toEqual(['pt_BR', 'pt', 'en'])
    expect(localeFallbackChain('en_US', 'en_US')).toEqual(['en_US', 'en'])
    expect(localeFallbackChain(null, 'de')).toEqual(['de'])
    expect(localeFallbackChain('zh-Hant-TW', 'en')).toEqual(['zh_Hant_TW', 'zh_Hant', 'zh', 'en'])
  })

  it('expands placeholders case-insensitively and handles $$', () => {
    expect(
      expandPlaceholders({
        message: 'Hello $USER$, you owe $$5 to $user$ ($unknown$)',
        placeholders: { User: { content: 'Ada' } }
      })
    ).toBe('Hello Ada, you owe $5 to Ada ($unknown$)')
    expect(expandPlaceholders({ message: 'Price: 5$' })).toBe('Price: 5$')
    expect(
      expandPlaceholders({ message: 'Order $1', placeholders: { n: { content: '$1' } } })
    ).toBe('Order $1')
  })

  it('merges catalogs with the requested locale winning over fallbacks', () => {
    const catalog = buildMessageCatalog([
      { greeting: { message: 'Hallo' } },
      { greeting: { message: 'Hello' }, FAREWELL: { message: 'Bye' } },
      null
    ])
    expect(catalog.get('greeting')).toBe('Hallo')
    expect(catalog.get('farewell')).toBe('Bye')
    const missing = new Set<string>()
    expect(
      substituteMessages('__MSG_Greeting__ and __MSG_farewell__ and __MSG_nope__', catalog, missing)
    ).toBe('Hallo and Bye and __MSG_nope__')
    expect([...missing]).toEqual(['nope'])
  })

  it('localises the keys Chrome localises and leaves the rest alone', () => {
    const catalog = buildMessageCatalog([
      {
        appName: { message: 'Localised name' },
        appDesc: { message: 'Localised description' },
        title: { message: 'Localised title' },
        cmd: { message: 'Localised command' }
      }
    ])
    const raw = {
      manifest_version: 3,
      name: '__MSG_appName__',
      description: '__MSG_appDesc__',
      version: '1',
      default_locale: 'en',
      action: { default_title: '__MSG_title__' },
      commands: { doIt: { description: '__MSG_cmd__' }, other: { description: '__MSG_missing__' } },
      homepage_url: 'https://example.com/__MSG_appName__'
    }
    const { manifest, missing } = localizeManifest(raw, catalog)
    expect(manifest.name).toBe('Localised name')
    expect(manifest.description).toBe('Localised description')
    expect((manifest.action as { default_title: string }).default_title).toBe('Localised title')
    expect((manifest.commands as Record<string, { description: string }>).doIt.description).toBe(
      'Localised command'
    )
    expect(manifest.homepage_url).toBe('https://example.com/__MSG_appName__')
    expect(missing).toEqual(['missing'])
    // The input is not mutated.
    expect(raw.name).toBe('__MSG_appName__')
  })
})
