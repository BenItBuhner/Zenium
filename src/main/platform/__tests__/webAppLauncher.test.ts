import { describe, expect, it } from 'vitest'
import {
  appSlug,
  desktopEntry,
  desktopExecLine,
  encodeIcns,
  encodeIco,
  icnsType,
  launchCommand,
  launcherFileName,
  macBundleOf,
  macInfoPlist,
  macLauncherScript,
  tileHtml
} from '../webAppLauncher'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

describe('appSlug / launcherFileName', () => {
  it('derives a stable filesystem handle from the app id', () => {
    expect(appSlug('https://app.example/')).toMatch(/^[0-9a-f]{16}$/)
    expect(appSlug('https://app.example/')).toBe(appSlug('https://app.example/'))
    expect(appSlug('https://app.example/')).not.toBe(appSlug('https://app.example/x'))
  })

  it('keeps the launcher name readable and safe for every filesystem', () => {
    expect(launcherFileName('Sketch Studio')).toBe('Sketch Studio')
    expect(launcherFileName('  A/B:C*D?E"F<G>H|I  ')).toBe('A B C D E F G H I')
    expect(launcherFileName('...')).toBe('Web app')
    expect(launcherFileName('')).toBe('Web app')
    expect(launcherFileName('x'.repeat(100))).toHaveLength(60)
    expect(launcherFileName('.hidden.')).toBe('hidden')
  })
})

describe('launchCommand / desktopExecLine', () => {
  it('runs the packaged executable with --app=, or the AppImage it came from', () => {
    const url = 'https://app.example/start?x=1'
    expect(
      launchCommand(url, { execPath: '/opt/Zenium/zenium', isPackaged: true, appPath: '/opt/x' })
    ).toEqual({ program: '/opt/Zenium/zenium', args: [`--app=${url}`] })
    expect(
      launchCommand(url, {
        execPath: '/tmp/.mount_zen/zenium',
        isPackaged: true,
        appPath: '/tmp/.mount_zen/resources/app',
        appImage: '/home/u/Apps/zenium.AppImage'
      }).program
    ).toBe('/home/u/Apps/zenium.AppImage')
  })

  it('runs Electron with the app path in development', () => {
    expect(
      launchCommand('https://a.example/', {
        execPath: '/repo/node_modules/electron/dist/electron',
        isPackaged: false,
        appPath: '/repo'
      })
    ).toEqual({
      program: '/repo/node_modules/electron/dist/electron',
      args: ['/repo', '--app=https://a.example/']
    })
  })

  it('quotes and escapes the Exec line the way the desktop entry specification wants', () => {
    const line = desktopExecLine({
      program: '/opt/Zen ium/zenium',
      args: ['--app=https://a.example/?q=100%25&x="y"&z=$HOME`w`\\']
    })
    expect(line).toBe(
      '"/opt/Zen ium/zenium" "--app=https://a.example/?q=100%%25&x=\\"y\\"&z=\\$HOME\\`w\\`\\\\"'
    )
  })
})

describe('desktopEntry', () => {
  it('writes an application entry with the app name, icon, comment and window class', () => {
    const entry = desktopEntry({
      name: 'Sketch\nStudio',
      url: 'https://app.example/',
      exec: '"/opt/zenium" "--app=https://app.example/"',
      icon: '/home/u/.config/Zenium/zen/webapps/abc/icon.png',
      wmClass: 'zenium'
    })
    expect(entry).toContain('[Desktop Entry]\n')
    expect(entry).toContain('Type=Application\n')
    expect(entry).toContain('Name=Sketch Studio\n')
    expect(entry).toContain('Comment=https://app.example/\n')
    expect(entry).toContain('Exec="/opt/zenium" "--app=https://app.example/"\n')
    expect(entry).toContain('Icon=/home/u/.config/Zenium/zen/webapps/abc/icon.png\n')
    expect(entry).toContain('StartupWMClass=zenium\n')
    expect(entry).toContain('X-Zenium-WebApp=true\n')
    expect(entry.endsWith('\n')).toBe(true)
  })
})

describe('macOS bundle files', () => {
  it('writes an Info.plist naming the launcher, its icon and the app URL', () => {
    const plist = macInfoPlist({
      name: 'Sketch & Co',
      bundleId: 'io.github.benitbuhner.zenium.app.abc',
      executable: 'app',
      iconFile: 'app.icns',
      url: 'https://app.example/?a=1&b=<2>'
    })
    expect(plist).toContain('<key>CFBundleName</key>\n\t<string>Sketch &amp; Co</string>')
    expect(plist).toContain('<key>CFBundleExecutable</key>\n\t<string>app</string>')
    expect(plist).toContain('<key>CFBundleIconFile</key>\n\t<string>app.icns</string>')
    expect(plist).toContain(
      '<key>CFBundleIdentifier</key>\n\t<string>io.github.benitbuhner.zenium.app.abc</string>'
    )
    expect(plist).toContain('<string>https://app.example/?a=1&amp;b=&lt;2&gt;</string>')
    expect(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
  })

  it('finds the browser bundle from its executable and launches through open -n', () => {
    expect(macBundleOf('/Applications/Zenium.app/Contents/MacOS/Zenium')).toBe(
      '/Applications/Zenium.app'
    )
    expect(
      macBundleOf('/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
    ).toBe('/repo/node_modules/electron/dist/Electron.app')
    expect(macBundleOf('/usr/local/bin/zenium')).toBeNull()
    const script = macLauncherScript(
      {
        program: '/Applications/Zenium.app/Contents/MacOS/Zenium',
        args: ["--app=https://a.example/?x='1'"]
      },
      '/Applications/Zenium.app'
    )
    expect(script).toBe(
      `#!/bin/sh\nexec open -n -a '/Applications/Zenium.app' --args '--app=https://a.example/?x='\\''1'\\'''\n`
    )
    // Development: Electron directly, with the app path.
    expect(
      macLauncherScript(
        { program: '/e/electron', args: ['/repo', '--app=https://a.example/'] },
        null
      )
    ).toBe(`#!/bin/sh\nexec '/e/electron' '/repo' '--app=https://a.example/'\n`)
  })
})

describe('icon containers', () => {
  it('lays out an ICO directory over PNG payloads, 256 written as 0', () => {
    const a = new Uint8Array([...PNG, 0xaa])
    const b = new Uint8Array([...PNG, 0xbb, 0xbb])
    const ico = encodeIco([
      { size: 16, png: a },
      { size: 256, png: b }
    ])
    const view = new DataView(ico.buffer)
    expect(view.getUint16(0, true)).toBe(0)
    expect(view.getUint16(2, true)).toBe(1)
    expect(view.getUint16(4, true)).toBe(2)
    // Entry 0: 16 px, 32 bpp, size and offset of its PNG.
    expect([ico[6], ico[7]]).toEqual([16, 16])
    expect(view.getUint16(6 + 6, true)).toBe(32)
    expect(view.getUint32(6 + 8, true)).toBe(a.byteLength)
    const offsetA = view.getUint32(6 + 12, true)
    expect(offsetA).toBe(6 + 16 * 2)
    expect(Array.from(ico.slice(offsetA, offsetA + a.byteLength))).toEqual(Array.from(a))
    // Entry 1: 256 px written as 0/0.
    expect([ico[22], ico[23]]).toEqual([0, 0])
    const offsetB = view.getUint32(22 + 12, true)
    expect(offsetB).toBe(offsetA + a.byteLength)
    expect(Array.from(ico.slice(offsetB))).toEqual(Array.from(b))
    expect(ico.byteLength).toBe(6 + 32 + a.byteLength + b.byteLength)
  })

  it('skips images too large for an ICO and refuses an empty one', () => {
    const ico = encodeIco([
      { size: 512, png: PNG },
      { size: 32, png: PNG }
    ])
    expect(new DataView(ico.buffer).getUint16(4, true)).toBe(1)
    expect(() => encodeIco([{ size: 512, png: PNG }])).toThrow()
  })

  it('lays out an ICNS with one typed element per known size, big-endian lengths', () => {
    const icns = encodeIcns([
      { size: 16, png: PNG },
      { size: 512, png: PNG },
      { size: 100, png: PNG }
    ])
    const text = (at: number): string => String.fromCharCode(...icns.slice(at, at + 4))
    const view = new DataView(icns.buffer)
    expect(text(0)).toBe('icns')
    expect(view.getUint32(4, false)).toBe(icns.byteLength)
    expect(icns.byteLength).toBe(8 + 2 * (8 + PNG.byteLength))
    expect(text(8)).toBe('icp4')
    expect(view.getUint32(12, false)).toBe(8 + PNG.byteLength)
    expect(text(8 + 8 + PNG.byteLength)).toBe('ic09')
    expect(icnsType(1024)).toBe('ic10')
    expect(icnsType(48)).toBeNull()
    expect(() => encodeIcns([{ size: 48, png: PNG }])).toThrow()
  })
})

describe('tileHtml', () => {
  it('draws a letter tile on the sheet colour with the matching ink', () => {
    const html = tileHtml({
      icon: null,
      kind: null,
      background: '#1f2937',
      iconBackground: null,
      name: 'sketch studio',
      size: 512,
      rounded: false
    })
    expect(html).toContain('background:#1f2937;color:#ffffff')
    expect(html).toContain('>S</span>')
    expect(html).toContain('width:512px;height:512px')
    expect(html).toContain('border-radius:0px')
  })

  it('fills the tile with a maskable icon and rounds it on macOS', () => {
    const html = tileHtml({
      icon: 'data:image/png;base64,AAAA',
      kind: 'maskable',
      background: '#ffffff',
      iconBackground: null,
      name: 'X',
      size: 512,
      rounded: true
    })
    expect(html).toContain('object-fit:cover')
    expect(html).toContain('border-radius:115px')
    expect(html).toContain('src="data:image/png;base64,AAAA"')
  })

  it('keeps an any icon whole, on the manifest background when one is named', () => {
    const plain = tileHtml({
      icon: 'data:image/svg+xml;base64,AAAA',
      kind: 'any',
      background: '#123456',
      iconBackground: null,
      name: 'X',
      size: 256,
      rounded: false
    })
    expect(plain).toContain('background:transparent')
    expect(plain).toContain('width:100%;height:100%;object-fit:contain')
    const backed = tileHtml({
      icon: 'data:image/png;base64,AAAA',
      kind: 'any',
      background: '#123456',
      iconBackground: '#abcdef',
      name: 'X',
      size: 256,
      rounded: false
    })
    expect(backed).toContain('background:#abcdef')
    expect(backed).toContain('width:80%;height:80%')
  })

  it('inks a monochrome glyph on the theme colour and escapes what it embeds', () => {
    const html = tileHtml({
      icon: 'data:image/svg+xml,<svg "x"></svg>',
      kind: 'monochrome',
      background: 'not a colour',
      iconBackground: null,
      name: '<b>',
      size: 256,
      rounded: false
    })
    expect(html).toContain(
      '-webkit-mask:url(&quot;data:image/svg+xml,&lt;svg &quot;x&quot;>&lt;/svg>&quot;)'
    )
    // An unpaintable colour falls to grey rather than breaking the style.
    expect(html).toContain('background:#8a8a8e')
    expect(html).not.toContain('not a colour')
  })
})
