import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BROWSER_SCENARIO,
  LAUNCH_SERVICES_DOMAIN,
  WEB_SCHEMES,
  dialogOnScreen,
  dialogReading,
  parseLsHandlers,
  requestProblems,
  requestReading,
  urlTypeProblems,
  webHandlers
} from './default-browser-scenario.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')

// Info.plist as electron-builder writes it from electron-builder.yml's `protocols`.
const infoPlist = {
  CFBundleIdentifier: 'io.github.benitbuhner.zenium',
  CFBundleURLTypes: [
    {
      CFBundleTypeRole: 'Viewer',
      CFBundleURLName: 'Web URL',
      CFBundleURLSchemes: ['http', 'https']
    }
  ]
}

// com.apple.launchservices.secure as `defaults export` writes it: entries with a nested
// LSHandlerPreferredVersions dict whose own LSHandlerRoleAll ("-") must not pass for the entry's.
const lsXml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>LSHandlers</key>
	<array>
		<dict>
			<key>LSHandlerContentType</key>
			<string>public.html</string>
			<key>LSHandlerPreferredVersions</key>
			<dict>
				<key>LSHandlerRoleAll</key>
				<string>-</string>
			</dict>
			<key>LSHandlerRoleAll</key>
			<string>com.google.chrome</string>
		</dict>
		<dict>
			<key>LSHandlerPreferredVersions</key>
			<dict>
				<key>LSHandlerRoleAll</key>
				<string>-</string>
			</dict>
			<key>LSHandlerRoleAll</key>
			<string>io.github.benitbuhner.zenium</string>
			<key>LSHandlerURLScheme</key>
			<string>http</string>
		</dict>
		<dict>
			<key>LSHandlerRoleViewer</key>
			<string>com.apple.Safari</string>
			<key>LSHandlerURLScheme</key>
			<string>HTTPS</string>
		</dict>
		<dict/>
	</array>
	<key>LSHandlersVersion</key>
	<string>1</string>
</dict>
</plist>`

const lsJson = JSON.stringify({
  LSHandlers: [
    {
      LSHandlerPreferredVersions: { LSHandlerRoleAll: '-' },
      LSHandlerRoleAll: 'org.mozilla.firefox',
      LSHandlerURLScheme: 'http'
    },
    { LSHandlerRoleAll: 'org.mozilla.firefox', LSHandlerURLScheme: 'https' },
    { LSHandlerContentType: 'public.html', LSHandlerRoleAll: 'org.mozilla.firefox' }
  ]
})

const set = (scheme, result = true) => ({
  method: 'setAsDefaultProtocolClient',
  args: [scheme],
  result
})
const is = (scheme, result) => ({ method: 'isDefaultProtocolClient', args: [scheme], result })

describe('the scenario constants', () => {
  it('names the scenario the harness table and the macOS leg use', () => {
    expect(DEFAULT_BROWSER_SCENARIO).toBe('default-browser')
    expect(read('.github/workflows/desktop-smoke.yml')).toMatch(
      /--scenarios [a-z,-]*\bdefault-browser\b/
    )
    expect(WEB_SCHEMES).toEqual(['http', 'https'])
  })

  it('reads the LaunchServices domain mac-facts.sh reads', () => {
    expect(read('.github/smoke/mac-facts.sh')).toContain(
      `defaults export ${LAUNCH_SERVICES_DOMAIN} -`
    )
  })

  it('claims the schemes electron-builder.yml’s protocols claim', () => {
    const yml = read('electron-builder.yml')
    for (const scheme of WEB_SCHEMES)
      expect(yml).toMatch(new RegExp(`schemes:\\n(?:\\s+- \\w+\\n)*\\s+- ${scheme}\\b`))
  })
})

describe('urlTypeProblems', () => {
  it('accepts a bundle that claims http and https', () => {
    expect(urlTypeProblems(infoPlist)).toEqual([])
  })

  it('names the scheme that is missing, the claim that is absent and a plist that could not be read', () => {
    expect(urlTypeProblems({ CFBundleURLTypes: [{ CFBundleURLSchemes: ['http'] }] })).toEqual([
      "Info.plist's CFBundleURLTypes do not claim https (schemes: http)"
    ])
    expect(urlTypeProblems({ CFBundleURLTypes: [{ CFBundleURLSchemes: ['mailto'] }] })).toEqual([
      "Info.plist's CFBundleURLTypes do not claim http (schemes: mailto)",
      "Info.plist's CFBundleURLTypes do not claim https (schemes: mailto)"
    ])
    expect(urlTypeProblems({ CFBundleIdentifier: 'x' })).toEqual([
      'Info.plist has no CFBundleURLTypes: the bundle claims no URL scheme'
    ])
    expect(urlTypeProblems(null)).toEqual(['Info.plist could not be read'])
  })

  it('reads the schemes without regard to case', () => {
    expect(
      urlTypeProblems({
        CFBundleURLTypes: [{ CFBundleURLSchemes: ['HTTP'] }, { CFBundleURLSchemes: ['Https'] }]
      })
    ).toEqual([])
  })
})

describe('parseLsHandlers', () => {
  it('reads the JSON plutil writes', () => {
    const handlers = parseLsHandlers(lsJson)
    expect(handlers).toHaveLength(3)
    expect(handlers[0].LSHandlerURLScheme).toBe('http')
  })

  it('reads the XML defaults export writes, an entry’s nested dict kept out of it', () => {
    const handlers = parseLsHandlers(lsXml)
    expect(handlers).toEqual([
      { LSHandlerContentType: 'public.html', LSHandlerRoleAll: 'com.google.chrome' },
      { LSHandlerRoleAll: 'io.github.benitbuhner.zenium', LSHandlerURLScheme: 'http' },
      { LSHandlerRoleViewer: 'com.apple.Safari', LSHandlerURLScheme: 'HTTPS' }
    ])
  })

  it('reads nothing out of an empty, malformed or unrelated text', () => {
    expect(parseLsHandlers('')).toEqual([])
    expect(parseLsHandlers(undefined)).toEqual([])
    expect(parseLsHandlers('{not json')).toEqual([])
    expect(parseLsHandlers('{"other": 1}')).toEqual([])
    expect(
      parseLsHandlers('<plist><dict><key>Foo</key><string>bar</string></dict></plist>')
    ).toEqual([])
  })
})

describe('webHandlers', () => {
  it('names who holds http and https, by RoleAll or RoleViewer, whatever the scheme’s case', () => {
    expect(webHandlers(parseLsHandlers(lsXml))).toEqual({
      http: 'io.github.benitbuhner.zenium',
      https: 'com.apple.Safari'
    })
    expect(webHandlers(parseLsHandlers(lsJson))).toEqual({
      http: 'org.mozilla.firefox',
      https: 'org.mozilla.firefox'
    })
  })

  it('reads null – the system default – when no entry names the scheme', () => {
    expect(webHandlers([])).toEqual({ http: null, https: null })
    expect(webHandlers(undefined)).toEqual({ http: null, https: null })
  })
})

describe('requestProblems', () => {
  it('accepts the request for http alone while http is not held', () => {
    expect(
      requestProblems({
        calls: [is('http', false), set('http'), is('http', false)],
        httpHeldBefore: false
      })
    ).toEqual([])
    expect(requestProblems({ calls: [set('http', false)], httpHeldBefore: false })).toEqual([])
  })

  it('accepts https claimed once LaunchServices reported http held', () => {
    expect(
      requestProblems({
        calls: [set('http'), is('http', false), is('http', true), is('https', false), set('https')],
        httpHeldBefore: false
      })
    ).toEqual([])
  })

  it('names a request that never reached LaunchServices', () => {
    expect(requestProblems({ calls: [], httpHeldBefore: false })).toEqual([
      'defaultBrowser.request made no app.setAsDefaultProtocolClient call'
    ])
    expect(requestProblems({ calls: [is('http', false)], httpHeldBefore: false })).toEqual([
      'defaultBrowser.request made no app.setAsDefaultProtocolClient call'
    ])
  })

  it('names https asked first, or before http was held (the second prompt)', () => {
    expect(requestProblems({ calls: [set('https'), set('http')], httpHeldBefore: false })).toEqual([
      "the first LaunchServices request was for 'https', expected 'http'",
      'https was requested before LaunchServices reported http held'
    ])
    expect(
      requestProblems({
        calls: [set('http'), is('http', false), set('https')],
        httpHeldBefore: false
      })
    ).toEqual(['https was requested before LaunchServices reported http held'])
  })

  it('expects only the quiet https claim when the app already held http', () => {
    expect(requestProblems({ calls: [set('https')], httpHeldBefore: true })).toEqual([])
    expect(requestProblems({ calls: [set('http')], httpHeldBefore: true })).toEqual([
      'http was requested again although the app already held it'
    ])
  })
})

describe('requestReading', () => {
  it('reads how LaunchServices took the http request', () => {
    expect(requestReading({ calls: [set('http', true)], httpHeldBefore: false })).toBe(
      "accepted (LSSetDefaultHandlerForURLScheme returned noErr: the dialog is the OS's)"
    )
    expect(requestReading({ calls: [set('http', false)], httpHeldBefore: false })).toBe(
      'refused (returned false)'
    )
    expect(
      requestReading({
        calls: [{ method: 'setAsDefaultProtocolClient', args: ['http'], error: 'boom' }],
        httpHeldBefore: false
      })
    ).toBe('threw: boom')
    expect(requestReading({ calls: [], httpHeldBefore: false })).toBe('not asked')
    expect(requestReading({ calls: [set('https')], httpHeldBefore: true })).toBe(
      'not asked: the app already held http'
    )
  })
})

describe('dialogReading', () => {
  const ok = (stdout) => ({ status: 0, stdout, stderr: '' })
  const failed = (stderr) => ({ status: 1, stdout: '', stderr })

  it('reads a session that refuses UI scripting as not automatable', () => {
    const r = dialogReading({
      windows: failed(
        'execution error: System Events got an error: osascript is not allowed assistive access. (-1719)'
      )
    })
    expect(r.dialog).toMatch(/^not automatable: .*-1719/)
    expect(r.clicked).toBe(false)
    expect(dialogOnScreen(r)).toBe(false)
    expect(dialogReading({ windows: failed('(-1743)') }).dialog).toMatch(/^not automatable/)
  })

  it('reads no agent process and no window as no dialog', () => {
    expect(
      dialogReading({
        windows: failed(
          'execution error: System Events got an error: Can’t get process "CoreServicesUIAgent". (-1728)'
        )
      })
    ).toEqual({
      dialog: 'no CoreServicesUIAgent process (no dialog up)',
      clicked: false
    })
    expect(dialogReading({ windows: ok('') })).toEqual({
      dialog: 'no CoreServicesUIAgent window on screen',
      clicked: false
    })
    expect(dialogReading({ windows: ok('missing value') }).dialog).toBe(
      'no CoreServicesUIAgent window on screen'
    )
    expect(dialogReading({ windows: null })).toEqual({ dialog: 'not looked at', clicked: false })
    expect(dialogReading({ windows: failed('some other error') }).dialog).toBe(
      'osascript failed: some other error'
    )
  })

  it('reads the dialog on screen, and the click’s outcome', () => {
    const windows = ok('Do you want to change your default web browser to “Zenium”?')
    const seen = dialogReading({ windows })
    expect(seen).toEqual({
      dialog: 'on screen: Do you want to change your default web browser to “Zenium”?',
      clicked: false
    })
    expect(dialogOnScreen(seen)).toBe(true)
    expect(
      dialogReading({
        windows,
        click: ok('button "Use “Zenium”" of window 1 of application process "CoreServicesUIAgent"')
      })
    ).toMatchObject({
      clicked: true,
      clickResult: expect.stringContaining('Use')
    })
    expect(dialogReading({ windows, click: failed('Can’t get button 1 (-1728)') })).toMatchObject({
      clicked: false,
      clickError: expect.stringContaining('-1728')
    })
  })
})
