import { describe, expect, it } from 'vitest'
import {
  getMessage,
  largestIcon,
  localeCandidates,
  ManifestError,
  parseRuntimeManifest,
  substituteMessages,
  type LocaleMessages
} from '../manifest'

const messages: LocaleMessages = {
  ext_name: { message: 'Dark Reader' },
  greeting: {
    message: 'Hello $USER$, you have $1 items',
    placeholders: { user: { content: '$2' } }
  },
  Mixed_Case: { message: 'ok' }
}

describe('parseRuntimeManifest', () => {
  it('normalises an MV3 manifest', () => {
    const m = parseRuntimeManifest(
      {
        manifest_version: 3,
        name: '__MSG_ext_name__',
        version: '4.9.96',
        description: 'desc',
        default_locale: 'en',
        icons: { '16': 'i16.png', '128': 'i128.png' },
        permissions: ['storage', 'alarms'],
        host_permissions: ['<all_urls>'],
        optional_permissions: ['tabs', 'https://x.example/*'],
        content_scripts: [
          {
            matches: ['<all_urls>'],
            js: ['a.js', 'b.js'],
            css: ['a.css'],
            run_at: 'document_start',
            all_frames: true
          },
          { matches: ['https://*.youtube.com/*'], js: ['c.js'] }
        ],
        background: { service_worker: 'bg.js', type: 'module' },
        action: {
          default_title: 'T',
          default_popup: 'popup.html',
          default_icon: { '19': 'a19.png' }
        },
        options_ui: { page: 'options.html', open_in_tab: true },
        web_accessible_resources: [{ resources: ['inject/*.js'], matches: ['https://*/*'] }],
        declarative_net_request: {
          rule_resources: [{ id: 'default', enabled: true, path: 'rules/default.json' }]
        },
        commands: { toggle: { suggested_key: { default: 'Alt+Shift+D' }, description: 'Toggle' } },
        content_security_policy: { extension_pages: "script-src 'self'" },
        minimum_chrome_version: '100'
      },
      messages
    )
    expect(m.manifestVersion).toBe(3)
    expect(m.name).toBe('Dark Reader')
    expect(m.permissions).toEqual(['storage', 'alarms'])
    expect(m.hostPermissions).toEqual(['<all_urls>'])
    expect(m.optionalPermissions).toEqual(['tabs'])
    expect(m.optionalHostPermissions).toEqual(['https://x.example/*'])
    expect(m.contentScripts).toHaveLength(2)
    expect(m.contentScripts[0]).toMatchObject({
      runAt: 'document_start',
      allFrames: true,
      js: ['a.js', 'b.js'],
      css: ['a.css'],
      world: 'ISOLATED'
    })
    expect(m.contentScripts[1]).toMatchObject({ runAt: 'document_idle', allFrames: false })
    expect(m.background).toEqual({ kind: 'service_worker', script: 'bg.js', module: true })
    expect(m.action).toEqual({
      source: 'action',
      title: 'T',
      popup: 'popup.html',
      icons: { '19': 'a19.png' }
    })
    expect(m.options).toEqual({ page: 'options.html', openInTab: true })
    expect(m.webAccessibleResources).toEqual([
      { resources: ['inject/*.js'], matches: ['https://*/*'], useDynamicUrl: false }
    ])
    expect(m.rulesets).toEqual([{ id: 'default', path: 'rules/default.json', enabled: true }])
    expect(m.commands).toEqual([
      { name: 'toggle', description: 'Toggle', suggestedKey: 'Alt+Shift+D' }
    ])
    expect(m.extensionPagesCsp).toBe("script-src 'self'")
    expect(m.minimumChromeVersion).toBe('100')
    expect(largestIcon(m.icons)).toBe('i128.png')
  })

  it('the document getManifest() serves has its localisable strings resolved, the rest as written', () => {
    const source = {
      manifest_version: 3,
      name: '__MSG_name_release__',
      short_name: '__MSG_ext_name__',
      description: '__MSG_ext_name__ blocks ads',
      version: '4.44.0',
      default_locale: 'en',
      action: { default_title: '__MSG_ext_name__' },
      commands: { toggle: { description: '__MSG_ext_name__ on/off' } },
      // Not a localised key: stays as written, whatever it looks like.
      homepage_url: 'https://__MSG_ext_name__.example/'
    }
    const m = parseRuntimeManifest(source, {
      ...messages,
      name_release: { message: 'Adblock Plus - free ad blocker' }
    })
    // Adblock Plus reads `short_name` from getManifest() and wants "Adblock Plus" back.
    expect(m.raw.short_name).toBe('Dark Reader')
    expect(m.raw.name).toBe('Adblock Plus - free ad blocker')
    expect(m.raw.description).toBe('Dark Reader blocks ads')
    expect(m.raw.action).toEqual({ default_title: 'Dark Reader' })
    expect(m.raw.commands).toEqual({ toggle: { description: 'Dark Reader on/off' } })
    expect(m.raw.homepage_url).toBe('https://__MSG_ext_name__.example/')
    // The source document is not written to.
    expect(source.short_name).toBe('__MSG_ext_name__')
    // No `_locales`: the document as written.
    expect(parseRuntimeManifest({ ...source, name: 'Plain' }, null).raw.short_name).toBe(
      '__MSG_ext_name__'
    )
  })

  it('normalises an MV2 manifest (host patterns inside permissions, browser_action, scripts background)', () => {
    const m = parseRuntimeManifest(
      {
        manifest_version: 2,
        name: 'uBlock Origin',
        version: '1.60.0',
        permissions: ['storage', 'webRequest', 'webRequestBlocking', '<all_urls>', 'http://*/*'],
        background: { scripts: ['a.js', 'b.js'], persistent: true },
        browser_action: { default_popup: 'popup.html' },
        options_page: 'dashboard.html',
        web_accessible_resources: ['web_accessible_resources/*'],
        content_security_policy: "script-src 'self'; object-src 'self'"
      },
      null
    )
    expect(m.permissions).toEqual(['storage', 'webRequest', 'webRequestBlocking'])
    expect(m.hostPermissions).toEqual(['<all_urls>', 'http://*/*'])
    expect(m.background).toEqual({ kind: 'scripts', scripts: ['a.js', 'b.js'], persistent: true })
    expect(m.action?.source).toBe('browser_action')
    expect(m.options).toEqual({ page: 'dashboard.html', openInTab: true })
    expect(m.webAccessibleResources).toEqual([
      { resources: ['web_accessible_resources/*'], matches: ['<all_urls>'], useDynamicUrl: false }
    ])
    expect(m.extensionPagesCsp).toBe("script-src 'self'; object-src 'self'")
  })

  it('leaves out an API permission outside its manifest version, as Chrome refuses to grant it', () => {
    // Stylus 2.4.11 (MV3) declares webRequestBlocking and asks permissions.contains for it: the
    // answer Chrome gives is false, and Stylus registers observationally on it.
    const mv3 = parseRuntimeManifest(
      {
        manifest_version: 3,
        name: 'Stylus',
        version: '2.4.11',
        permissions: ['webRequest', 'webRequestBlocking', 'storage', 'scripting'],
        optional_permissions: ['webRequestBlocking', 'downloads', 'https://x.example/*']
      },
      null
    )
    expect(mv3.permissions).toEqual(['webRequest', 'storage', 'scripting'])
    expect(mv3.optionalPermissions).toEqual(['downloads'])
    expect(mv3.optionalHostPermissions).toEqual(['https://x.example/*'])
    // The MV3 APIs never existed in MV2; webRequestBlocking is MV2's to keep.
    const mv2 = parseRuntimeManifest(
      {
        manifest_version: 2,
        name: 'Legacy',
        version: '1.0',
        permissions: ['webRequest', 'webRequestBlocking', 'scripting', 'offscreen', 'sidePanel', 'userScripts', 'tabs']
      },
      null
    )
    expect(mv2.permissions).toEqual(['webRequest', 'webRequestBlocking', 'tabs'])
  })

  it('rejects broken manifests with a clear reason', () => {
    expect(() => parseRuntimeManifest(null, null)).toThrow(ManifestError)
    expect(() =>
      parseRuntimeManifest({ manifest_version: 1, name: 'x', version: '1' }, null)
    ).toThrow(/manifest_version/)
    expect(() => parseRuntimeManifest({ manifest_version: 3, version: '1' }, null)).toThrow(/name/)
    expect(() =>
      parseRuntimeManifest({ manifest_version: 3, name: 'x', version: 'a.b' }, null)
    ).toThrow(/version/)
    expect(() =>
      parseRuntimeManifest(
        { manifest_version: 3, name: 'x', version: '1', content_scripts: [{ js: ['a.js'] }] },
        null
      )
    ).toThrow(/matches/)
    expect(() =>
      parseRuntimeManifest(
        {
          manifest_version: 3,
          name: 'x',
          version: '1',
          content_scripts: [{ matches: ['<all_urls>'], run_at: 'later' }]
        },
        null
      )
    ).toThrow(/run_at/)
  })
})

describe('i18n', () => {
  it('orders locale candidates like Chrome', () => {
    expect(localeCandidates('en-US', 'de')).toEqual(['en_US', 'en', 'de'])
    expect(localeCandidates('de', 'de')).toEqual(['de'])
    expect(localeCandidates('pt_BR', null)).toEqual(['pt_BR', 'pt'])
  })

  it('resolves messages with placeholders and positional substitutions, case-insensitively', () => {
    expect(getMessage(messages, 'ext_name')).toBe('Dark Reader')
    expect(getMessage(messages, 'greeting', ['3', 'Ada'])).toBe('Hello Ada, you have 3 items')
    expect(getMessage(messages, 'mixed_case')).toBe('ok')
    expect(getMessage(messages, 'missing')).toBe('')
    expect(getMessage(null, 'ext_name')).toBe('')
  })

  it('substitutes __MSG_x__ and leaves unknown names alone', () => {
    expect(substituteMessages('__MSG_ext_name__ (__MSG_nope__)', messages)).toBe(
      'Dark Reader (__MSG_nope__)'
    )
    expect(substituteMessages('__MSG_ext_name__', null)).toBe('__MSG_ext_name__')
  })
})
