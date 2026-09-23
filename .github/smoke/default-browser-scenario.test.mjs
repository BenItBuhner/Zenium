import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BROWSER_SCENARIO,
  LAUNCH_SERVICES_DOMAIN,
  WEB_SCHEMES,
  clickUseScript,
  dialogOnScreen,
  dialogReading,
  findDefaultBrowserDialog,
  followThroughProblems,
  parseLsHandlers,
  parseWindowScan,
  requestProblems,
  requestReading,
  urlTypeProblems,
  webHandlers,
  windowScanScript
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

// The window scan's output as `windowScanScript` prints it: pid, process, index, name, static
// texts, buttons – tabs between, ' | ' within the lists.
const dialogLine = [
  '812',
  'CoreServicesUIAgent',
  '1',
  '',
  'Do you want to change your default web browser to “Zenium” or keep using “Safari”? | You can change this later in System Settings.',
  'Use “Zenium” | Keep “Safari”'
].join('\t')
const scanWithDialog = [
  '501\tFinder\t1\tDesktop\t\t',
  '4321\tZenium\t1\tZenium\tMake Zenium your default web browser | Not now\tUse Zenium | Keep',
  dialogLine,
  'short\tline',
  ''
].join('\n')
const scanWithout = ['501\tFinder\t1\tDesktop\t\t', '777\tTerminal\t2\truns\t\t'].join('\n')

describe('parseWindowScan', () => {
  it('reads one window per line, its lists split on the separator', () => {
    const windows = parseWindowScan(scanWithDialog)
    expect(windows).toHaveLength(3)
    expect(windows[0]).toEqual({
      pid: 501,
      process: 'Finder',
      index: 1,
      name: 'Desktop',
      texts: [],
      buttons: []
    })
    expect(windows[2]).toEqual({
      pid: 812,
      process: 'CoreServicesUIAgent',
      index: 1,
      name: '',
      texts: [
        'Do you want to change your default web browser to “Zenium” or keep using “Safari”?',
        'You can change this later in System Settings.'
      ],
      buttons: ['Use “Zenium”', 'Keep “Safari”']
    })
  })

  it('reads nothing out of an empty output', () => {
    expect(parseWindowScan('')).toEqual([])
    expect(parseWindowScan(undefined)).toEqual([])
    expect(parseWindowScan('\n\n')).toEqual([])
  })
})

describe('findDefaultBrowserDialog', () => {
  it('finds the dialog by its text, whoever owns it, and skips the app’s own windows', () => {
    const windows = parseWindowScan(scanWithDialog)
    expect(findDefaultBrowserDialog(windows, { ownProcess: 'Zenium' })?.pid).toBe(812)
    expect(
      findDefaultBrowserDialog(
        parseWindowScan('99\tUserNotificationCenter\t3\t\tChange your default web browser?\tOK'),
        { ownProcess: 'Zenium' }
      )?.process
    ).toBe('UserNotificationCenter')
    // Without the exclusion the app's own banner would pass for the dialog.
    expect(findDefaultBrowserDialog(windows)?.process).toBe('Zenium')
  })

  it('finds the dialog by its two answers when its text says nothing', () => {
    const windows = parseWindowScan('12\tagent\t1\t\tsomething else\tUse “Zenium” | Keep “Safari”')
    expect(findDefaultBrowserDialog(windows)?.pid).toBe(12)
    expect(
      findDefaultBrowserDialog(parseWindowScan('12\tagent\t1\t\tsomething else\tKeep “Safari”'))
    ).toBeNull()
  })

  it('finds none among unrelated windows', () => {
    expect(findDefaultBrowserDialog(parseWindowScan(scanWithout))).toBeNull()
    expect(findDefaultBrowserDialog([])).toBeNull()
    expect(findDefaultBrowserDialog(undefined)).toBeNull()
  })
})

describe('dialogReading', () => {
  const ok = (stdout) => ({ status: 0, stdout, stderr: '' })
  const failed = (stderr) => ({ status: 1, stdout: '', stderr })

  it('reads a session that refuses UI scripting as not automatable', () => {
    const r = dialogReading({
      scan: failed(
        'execution error: System Events got an error: osascript is not allowed assistive access. (-1719)'
      )
    })
    expect(r.dialog).toMatch(/^not automatable: .*-1719/)
    expect(r.clicked).toBe(false)
    expect(dialogOnScreen(r)).toBe(false)
    expect(dialogReading({ scan: failed('(-1743)') }).dialog).toMatch(/^not automatable/)
  })

  it('reads a scan without the dialog, and one that could not run', () => {
    expect(dialogReading({ scan: ok(scanWithout) })).toEqual({
      dialog: 'no default-browser dialog among the 2 window(s) of 2 process(es) on screen',
      clicked: false,
      windows: 2
    })
    expect(dialogReading({ scan: ok('') }).dialog).toBe(
      'no default-browser dialog among the 0 window(s) of 0 process(es) on screen'
    )
    expect(dialogReading({ scan: null })).toEqual({ dialog: 'not looked at', clicked: false })
    expect(dialogReading({ scan: failed('some other error') }).dialog).toBe(
      'osascript failed: some other error'
    )
    expect(
      dialogReading({ scan: { status: null, stdout: '', stderr: '', error: 'ETIMEDOUT' } }).dialog
    ).toBe('osascript failed: ETIMEDOUT')
  })

  it('reads the dialog on screen with its owner, and the click’s outcome', () => {
    const scan = ok(scanWithDialog)
    const seen = dialogReading({ scan, ownProcess: 'Zenium' })
    expect(seen).toEqual({
      dialog:
        'on screen (CoreServicesUIAgent, pid 812, window 1): Do you want to change your default web browser to “Zenium” or keep using “Safari”? You can change this later in System Settings.',
      process: 'CoreServicesUIAgent',
      pid: 812,
      index: 1,
      buttons: ['Use “Zenium”', 'Keep “Safari”'],
      windows: 3,
      clicked: false
    })
    expect(dialogOnScreen(seen)).toBe(true)
    expect(
      dialogReading({ scan, ownProcess: 'Zenium', click: ok('clicked Use “Zenium”') })
    ).toMatchObject({
      pid: 812,
      clicked: true,
      clickResult: 'clicked Use “Zenium”'
    })
    expect(
      dialogReading({
        scan,
        ownProcess: 'Zenium',
        click: failed('execution error: no button beginning with Use in window 1 (-2700)')
      })
    ).toMatchObject({
      clicked: false,
      clickError: expect.stringContaining('no button beginning with Use')
    })
  })
})

describe('followThroughProblems', () => {
  const settled = { settled: true, result: true, error: null }

  it('judges nothing without a click, or while the OS has not reported http held', () => {
    expect(
      followThroughProblems({
        clicked: false,
        held: { http: false, https: false },
        calls: [set('http')],
        request: { settled: false }
      })
    ).toEqual([])
    expect(
      followThroughProblems({
        clicked: true,
        held: { http: false, https: false },
        calls: [set('http')],
        request: { settled: false }
      })
    ).toEqual([])
  })

  it('accepts the https claim and the request resolved true once http is held', () => {
    expect(
      followThroughProblems({
        clicked: true,
        held: { http: true, https: true },
        calls: [set('http'), is('http', true), is('https', false), set('https')],
        request: settled
      })
    ).toEqual([])
  })

  it('names a missing https claim and a request that did not resolve true', () => {
    expect(
      followThroughProblems({
        clicked: true,
        held: { http: true, https: false },
        calls: [set('http'), is('http', true)],
        request: { settled: false }
      })
    ).toEqual([
      'http is held after the yes but the app never claimed https (macClaimHttps)',
      'the request has not resolved although the app holds http'
    ])
    expect(
      followThroughProblems({
        clicked: true,
        held: { http: true, https: true },
        calls: [set('http'), set('https')],
        request: { settled: true, result: null }
      })
    ).toEqual(['the request resolved null although the app holds http'])
  })
})

describe('the AppleScripts', () => {
  it('scans every process but the app’s own, one tab-separated line per window', () => {
    const script = windowScanScript('Zenium')
    expect(script).toContain('every application process')
    expect(script).toContain('pn does not start with "Zenium"')
    expect(script).toContain('every static text of w')
    expect(script).toContain('every button of g')
    expect(script).toMatch(/tab & pn & tab & \(idx as text\) & tab/)
    expect(windowScanScript()).toContain('"" is ""')
  })

  it('presses the first Use button in the window of the process given', () => {
    const script = clickUseScript(812, 1)
    expect(script).toContain('first application process whose unix id is 812')
    expect(script).toContain('set w to window 1')
    expect(script).toContain('first button of w whose name begins with "Use"')
    expect(script).toContain('first button of g whose name begins with "Use"')
    expect(() => clickUseScript('812', 0)).toThrow(/1-based window index/)
    expect(() => clickUseScript(undefined, 1)).toThrow(/needs a pid/)
  })
})
