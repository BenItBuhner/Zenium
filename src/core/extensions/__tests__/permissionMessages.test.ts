import { describe, expect, it } from 'vitest'
import {
  distinctHosts,
  matchesEffectiveTld,
  newWarnings,
  parseMatchPattern,
  permissionIdsForManifest,
  permissionWarningLines,
  permissionWarnings,
  registryOf
} from '../permissionMessages'

const lines = (manifest: Parameters<typeof permissionWarnings>[0]): string[] =>
  permissionWarnings(manifest).map((w) => w.message)

// Permission-relevant keys of real store manifests (internal/extensions/top30 fixtures), with the
// warnings the Chrome Web Store shows for them.
const DARK_READER = {
  manifest_version: 3,
  permissions: ['alarms', 'fontSettings', 'scripting', 'storage'],
  optional_permissions: ['contextMenus'],
  host_permissions: ['*://*/*'],
  content_scripts: [{ matches: ['<all_urls>'] }, { matches: ['<all_urls>'] }]
}

const UBLOCK_ORIGIN_LITE = {
  manifest_version: 3,
  permissions: [
    'activeTab',
    'alarms',
    'declarativeNetRequest',
    'offscreen',
    'scripting',
    'storage',
    'unlimitedStorage',
    'userScripts'
  ],
  host_permissions: ['<all_urls>']
}

const BITWARDEN = {
  manifest_version: 3,
  permissions: [
    'activeTab',
    'alarms',
    'clipboardRead',
    'clipboardWrite',
    'contextMenus',
    'idle',
    'offscreen',
    'scripting',
    'sidePanel',
    'storage',
    'tabs',
    'unlimitedStorage',
    'webNavigation',
    'webRequest',
    'webRequestAuthProvider',
    'notifications'
  ],
  optional_permissions: ['nativeMessaging', 'privacy'],
  host_permissions: ['https://*/*', 'http://*/*'],
  content_scripts: [{ matches: ['*://*/*', 'file:///*'] }, { matches: ['*://*/*', 'file:///*'] }]
}

const VIMIUM = {
  manifest_version: 3,
  permissions: [
    'tabs',
    'bookmarks',
    'history',
    'storage',
    'sessions',
    'notifications',
    'scripting',
    'favicon',
    'webNavigation',
    'search'
  ],
  host_permissions: ['<all_urls>'],
  content_scripts: [{ matches: ['<all_urls>'] }, { matches: ['file:///', 'file:///*/'] }]
}

const JSON_FORMATTER = {
  manifest_version: 3,
  permissions: ['storage'],
  host_permissions: ['*://*/*', '<all_urls>'],
  content_scripts: [{ matches: ['<all_urls>'] }]
}

describe('permissionWarnings: store fixtures', () => {
  it('Dark Reader', () => {
    expect(lines(DARK_READER)).toEqual(['Read and change all your data on all websites'])
  })

  it('uBlock Origin Lite: <all_urls> absorbs declarativeNetRequest', () => {
    expect(lines(UBLOCK_ORIGIN_LITE)).toEqual(['Read and change all your data on all websites'])
  })

  it('Bitwarden', () => {
    expect(lines(BITWARDEN)).toEqual([
      'Read and change all your data on all websites',
      'Display notifications',
      'Read and modify data you copy and paste'
    ])
  })

  it('Vimium: history wins over tabs/sessions, favicon and webNavigation are absorbed', () => {
    expect(lines(VIMIUM)).toEqual([
      'Read and change all your data on all websites',
      'Read and change your browsing history on all your signed-in devices',
      'Display notifications',
      'Read and change your bookmarks'
    ])
  })

  it('JSON Formatter', () => {
    expect(lines(JSON_FORMATTER)).toEqual(['Read and change all your data on all websites'])
  })

  it('optional permissions never warn at install time', () => {
    expect(lines({ manifest_version: 3, optional_permissions: ['history', 'bookmarks'] })).toEqual(
      []
    )
  })
})

describe('permissionWarnings: the no-warning set', () => {
  it('storage, alarms, activeTab, scripting, contextMenus, cookies, unlimitedStorage', () => {
    expect(
      lines({
        manifest_version: 3,
        permissions: [
          'storage',
          'alarms',
          'activeTab',
          'scripting',
          'contextMenus',
          'cookies',
          'unlimitedStorage',
          'sidePanel',
          'offscreen',
          'idle',
          'webRequest',
          'identity'
        ]
      })
    ).toEqual([])
  })

  it('unknown permissions are ignored like Chrome does', () => {
    expect(lines({ manifest_version: 3, permissions: ['notARealPermission'] })).toEqual([])
    expect(lines({ manifest_version: 2, permissions: ['notARealPermission'] })).toEqual([])
  })

  it('MV3 host patterns inside permissions are ignored', () => {
    expect(lines({ manifest_version: 3, permissions: ['https://example.com/*'] })).toEqual([])
  })
})

describe('permissionWarnings: API permissions', () => {
  it('single permissions produce Chrome strings', () => {
    const one = (permission: string): string[] =>
      lines({ manifest_version: 3, permissions: [permission] })
    expect(one('tabs')).toEqual(['Read your browsing history'])
    expect(one('webNavigation')).toEqual(['Read your browsing history'])
    expect(one('history')).toEqual([
      'Read and change your browsing history on all your signed-in devices'
    ])
    expect(one('downloads')).toEqual(['Manage your downloads'])
    expect(one('notifications')).toEqual(['Display notifications'])
    expect(one('bookmarks')).toEqual(['Read and change your bookmarks'])
    expect(one('geolocation')).toEqual(['Detect your physical location'])
    expect(one('management')).toEqual(['Manage your apps, extensions, and themes'])
    expect(one('nativeMessaging')).toEqual(['Communicate with cooperating native applications'])
    expect(one('clipboardRead')).toEqual(['Read data you copy and paste'])
    expect(one('clipboardWrite')).toEqual(['Modify data you copy and paste'])
    expect(one('declarativeNetRequest')).toEqual(['Block content on any page'])
    expect(one('declarativeNetRequestFeedback')).toEqual(['Read your browsing history'])
    expect(one('topSites')).toEqual(['Read a list of your most frequently visited websites'])
    expect(one('favicon')).toEqual(['Read the icons of the websites you visit'])
    expect(one('tabGroups')).toEqual(['View and manage your tab groups'])
    expect(one('privacy')).toEqual(['Change your privacy-related settings'])
    expect(one('desktopCapture')).toEqual(['Capture content of your screen'])
    expect(one('readingList')).toEqual(['Read and change entries in the reading list'])
    expect(one('identity.email')).toEqual(['Know your email address'])
    expect(one('downloads.open')).toEqual(['Open downloaded files'])
  })

  it('tabs + sessions reads history on all devices', () => {
    expect(lines({ manifest_version: 3, permissions: ['tabs', 'sessions'] })).toEqual([
      'Read your browsing history on all your signed-in devices'
    ])
    expect(lines({ manifest_version: 3, permissions: ['sessions'] })).toEqual([])
  })

  it('tabs absorbs topSites, favicon and webNavigation', () => {
    expect(
      lines({ manifest_version: 3, permissions: ['tabs', 'topSites', 'favicon', 'webNavigation'] })
    ).toEqual(['Read your browsing history'])
  })

  it('audio and video capture combine', () => {
    expect(lines({ manifest_version: 3, permissions: ['audioCapture', 'videoCapture'] })).toEqual([
      'Use your microphone and camera'
    ])
    expect(lines({ manifest_version: 3, permissions: ['videoCapture'] })).toEqual([
      'Use your camera'
    ])
  })

  it('debugger warns about the debugger and about all websites', () => {
    expect(lines({ manifest_version: 3, permissions: ['debugger', 'tabs'] })).toEqual([
      'Access the page debugger backend',
      'Read and change all your data on all websites'
    ])
  })

  it('pageCapture, tabCapture, proxy and devtools_page imply access to all websites', () => {
    for (const permission of ['pageCapture', 'tabCapture', 'proxy']) {
      expect(lines({ manifest_version: 3, permissions: [permission] })).toEqual([
        'Read and change all your data on all websites'
      ])
    }
    expect(lines({ manifest_version: 3, devtools_page: 'devtools.html' })).toEqual([
      'Read and change all your data on all websites'
    ])
  })

  it('new tab page override', () => {
    expect(lines({ manifest_version: 3, chrome_url_overrides: { newtab: 'ntp.html' } })).toEqual([
      'Replace the page you see when opening a new tab'
    ])
  })

  it('settings overrides name the host without www.', () => {
    expect(
      lines({
        manifest_version: 3,
        chrome_settings_overrides: {
          homepage: 'https://www.example.com/home',
          search_provider: { search_url: 'https://search.example.org/?q={searchTerms}' },
          startup_pages: ['https://start.example.net/']
        }
      })
    ).toEqual([
      'Change your home page to: example.com',
      'Change your search settings to: search.example.org',
      'Change your start page to: start.example.net'
    ])
  })

  it('structured fileSystem and mediaGalleries permissions', () => {
    expect(
      lines({ manifest_version: 2, permissions: [{ fileSystem: ['write', 'directory'] }] })
    ).toEqual(['Write to files and folders that you open in the application'])
    expect(
      lines({
        manifest_version: 2,
        permissions: [{ mediaGalleries: ['read', 'delete', 'allAutoDetected'] }]
      })
    ).toEqual(['Read and delete photos, music, and other media from your computer'])
  })

  it('enterprise.reportingPrivate differs per platform', () => {
    const manifest = { manifest_version: 3, permissions: ['enterprise.reportingPrivate'] }
    expect(permissionWarnings(manifest, 'win')[0].message).toBe(
      'Read information about your browser, OS, device, installed software, registry values and files'
    )
    expect(permissionWarnings(manifest, 'linux')[0].message).toBe(
      'Read information about your browser, OS, device, installed software and files'
    )
    expect(permissionWarnings(manifest, 'other')[0].message).toBe(
      'Read information about your browser, OS, and device'
    )
  })
})

describe('permissionWarnings: hosts', () => {
  it('one, two and three hosts are spelled out', () => {
    expect(lines({ manifest_version: 3, host_permissions: ['https://example.com/*'] })).toEqual([
      'Read and change your data on example.com'
    ])
    expect(
      lines({
        manifest_version: 3,
        host_permissions: ['https://example.com/*', 'https://other.org/*']
      })
    ).toEqual(['Read and change your data on example.com and other.org'])
    expect(
      lines({
        manifest_version: 3,
        host_permissions: ['https://c.com/*', 'https://a.com/*', 'https://b.com/*']
      })
    ).toEqual(['Read and change your data on a.com, b.com, and c.com'])
  })

  it('more than three hosts become a list', () => {
    const [warning] = permissionWarnings({
      manifest_version: 3,
      host_permissions: [
        'https://a.com/*',
        'https://b.com/*',
        'https://*.c.com/*',
        'https://d.com/*'
      ]
    })
    expect(warning.message).toBe('Read and change your data on a number of websites')
    expect(warning.details).toEqual(['All c.com sites', 'a.com', 'b.com', 'd.com'])
    expect(
      permissionWarningLines({
        manifest_version: 3,
        host_permissions: [
          'https://a.com/*',
          'https://b.com/*',
          'https://c.com/*',
          'https://d.com/*'
        ]
      })
    ).toEqual([
      'Read and change your data on a number of websites',
      '  a.com',
      '  b.com',
      '  c.com',
      '  d.com'
    ])
  })

  it('subdomain wildcards read "all X sites"', () => {
    expect(lines({ manifest_version: 3, host_permissions: ['*://*.google.com/*'] })).toEqual([
      'Read and change your data on all google.com sites'
    ])
  })

  it('sibling registries collapse onto the best one', () => {
    expect(
      lines({
        manifest_version: 3,
        host_permissions: ['https://google.de/*', 'https://google.com/*', 'https://google.fr/*']
      })
    ).toEqual(['Read and change your data on google.com'])
    expect(distinctHosts(['https://a.org/*', 'https://a.net/*'].map(parse))).toEqual(['a.net'])
    expect(distinctHosts(['https://a.de/*', 'https://a.fr/*'].map(parse))).toEqual(['a.de'])
  })

  it('all-hosts patterns in any form', () => {
    for (const pattern of ['<all_urls>', '*://*/*', 'http://*/*', 'https://*/', '*://*.com/*']) {
      expect(lines({ manifest_version: 3, host_permissions: [pattern] })).toEqual([
        'Read and change all your data on all websites'
      ])
    }
    expect(lines({ manifest_version: 3, host_permissions: ['*://*.co.uk/*'] })).toEqual([
      'Read and change all your data on all websites'
    ])
  })

  it('content script matches count as hosts', () => {
    expect(
      lines({ manifest_version: 3, content_scripts: [{ matches: ['https://github.com/*'] }] })
    ).toEqual(['Read and change your data on github.com'])
    expect(lines({ manifest_version: 3, content_scripts: [{ matches: ['<all_urls>'] }] })).toEqual([
      'Read and change all your data on all websites'
    ])
  })

  it('file patterns and chrome://favicon are special', () => {
    expect(lines({ manifest_version: 3, host_permissions: ['file:///*'] })).toEqual([])
    expect(lines({ manifest_version: 3, host_permissions: ['chrome://favicon/*'] })).toEqual([
      'Read the icons of the websites you visit'
    ])
    expect(lines({ manifest_version: 3, host_permissions: ['chrome://settings/*'] })).toEqual([])
  })

  it('MV2 host patterns live in permissions', () => {
    expect(
      lines({ manifest_version: 2, permissions: ['tabs', 'https://mail.google.com/*'] })
    ).toEqual(['Read and change your data on mail.google.com', 'Read your browsing history'])
  })

  it('invalid patterns are ignored', () => {
    expect(parseMatchPattern('https://example.com')).toBeNull()
    expect(parseMatchPattern('https://a.*.com/*')).toBeNull()
    expect(parseMatchPattern('chrome-extension://abc/*')).toBeNull()
    expect(parseMatchPattern('https://*.example.com:8080/*')).toEqual({
      scheme: 'https',
      host: 'example.com',
      matchSubdomains: true,
      matchAllUrls: false
    })
    expect(parseMatchPattern('https://bücher.example/*')?.host).toBe('xn--bcher-kva.example')
  })

  it('platform apps never warn about hosts', () => {
    expect(
      lines({
        manifest_version: 2,
        app: { background: { scripts: ['bg.js'] } },
        permissions: ['https://example.com/*']
      })
    ).toEqual([])
  })
})

describe('registry helpers', () => {
  it('registryOf', () => {
    expect(registryOf('example.com')).toBe('com')
    expect(registryOf('www.example.co.uk')).toBe('co.uk')
    expect(registryOf('example.de')).toBe('de')
    expect(registryOf('localhost')).toBe('')
    expect(registryOf('intranet.local')).toBe('')
  })

  it('matchesEffectiveTld', () => {
    expect(matchesEffectiveTld(parse('*://*.com/*'))).toBe(true)
    expect(matchesEffectiveTld(parse('*://*.example.com/*'))).toBe(false)
    expect(matchesEffectiveTld(parse('*://*.localhost/*'))).toBe(false)
    expect(matchesEffectiveTld(parse('*://example.com/*'))).toBe(false)
  })
})

describe('permission ids and privilege increase', () => {
  it('lists ids with parameters', () => {
    expect(
      permissionIdsForManifest({ manifest_version: 3, host_permissions: ['https://a.com/*'] })
    ).toEqual([{ id: 'kHostReadWrite', parameter: 'a.com' }])
  })

  it('newWarnings reports only additions', () => {
    const before = permissionWarnings({ manifest_version: 3, permissions: ['tabs'] })
    const after = permissionWarnings({ manifest_version: 3, permissions: ['tabs', 'bookmarks'] })
    expect(newWarnings(before, after).map((w) => w.message)).toEqual([
      'Read and change your bookmarks'
    ])
    expect(newWarnings(after, before)).toEqual([])
  })
})

function parse(text: string): NonNullable<ReturnType<typeof parseMatchPattern>> {
  const pattern = parseMatchPattern(text)
  if (!pattern) throw new Error(`Not a pattern: ${text}`)
  return pattern
}
