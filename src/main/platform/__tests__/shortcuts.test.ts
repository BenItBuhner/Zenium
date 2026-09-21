import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ShortcutRequest } from '../../../core/platform'

const written: Array<{ path: string; op: string; options: Record<string, unknown> }> = []

/** A PNG-shaped buffer the fake renderer answers with; the size is encoded so tests can see it. */
const png = (size: number): Uint8Array =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, size >> 8, size & 0xff])

vi.mock('electron', () => {
  const image = (bytes: Uint8Array): Record<string, unknown> => ({
    isEmpty: () => bytes.byteLength === 0,
    resize: ({ width }: { width: number }) => image(png(width)),
    toPNG: () => Buffer.from(bytes),
    getSize: () => ({ width: 512, height: 512 })
  })
  return {
    app: {
      isPackaged: true,
      getAppPath: () => '/opt/Zenium/resources/app.asar',
      getPath: (name: string) => {
        if (name === 'desktop') return process.env['TEST_DESKTOP'] ?? ''
        if (name === 'appData') return process.env['TEST_APPDATA'] ?? ''
        return ''
      }
    },
    nativeImage: {
      createFromBuffer: (b: Buffer) => image(new Uint8Array(b)),
      createFromDataURL: () => image(new Uint8Array()),
      createFromPath: () => image(png(512))
    },
    net: { fetch: async () => ({ ok: false }) },
    shell: {
      writeShortcutLink: (path: string, op: string, options: Record<string, unknown>) => {
        written.push({ path, op, options })
        return true
      }
    },
    BrowserWindow: class {}
  }
})

import { ElectronShortcuts, LAUNCHER_FOLDER } from '../shortcuts'
import { appSlug } from '../webAppLauncher'

const REQUEST: ShortcutRequest = {
  id: 'https://app.example/',
  url: 'https://app.example/start',
  title: 'Sketch Studio',
  iconUrl: 'https://app.example/icon.png',
  iconKind: 'maskable',
  background: '#336699',
  iconBackground: null
}

interface Harness {
  root: string
  profile: string
  paths: {
    applications: string
    desktop: string
    startMenuPrograms: string
    userApplications: string
  }
  confirmed: Array<{ id: string; icon: string | null }>
  rendered: string[]
  fetched: string[]
  host(platform: NodeJS.Platform, options?: { render?: boolean; icon?: boolean }): ElectronShortcuts
}

function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'zen-shortcuts-'))
  const paths = {
    applications: join(root, 'applications'),
    desktop: join(root, 'Desktop'),
    startMenuPrograms: join(root, 'Programs'),
    userApplications: join(root, 'Applications')
  }
  const confirmed: Harness['confirmed'] = []
  const rendered: string[] = []
  const fetched: string[] = []
  return {
    root,
    profile: join(root, 'webapps'),
    paths,
    confirmed,
    rendered,
    fetched,
    host: (platform, options = {}) =>
      new ElectronShortcuts(
        join(root, 'webapps'),
        (id, details) => confirmed.push({ id, icon: details.icon }),
        {
          platform,
          paths,
          execPath:
            platform === 'win32' ? 'C:\\Program Files\\Zenium\\zenium.exe' : '/opt/Zenium/zenium',
          isPackaged: true,
          appPath: '/opt/Zenium/resources/app.asar',
          appImage: null,
          fallbackIcon: () => png(512),
          renderTile:
            options.render === false
              ? async () => null
              : async (html, size) => {
                  rendered.push(html)
                  return png(size)
                },
          fetchIcon:
            options.icon === false
              ? async () => null
              : async (url) => {
                  fetched.push(url)
                  return { bytes: new Uint8Array([1, 2, 3]), type: 'image/png' }
                }
        }
      )
  }
}

let h: Harness

beforeEach(() => {
  written.length = 0
  h = harness()
})

afterEach(() => {
  rmSync(h.root, { recursive: true, force: true })
})

/**
 * A launcher path is gone once `unpin()` has run: `rm` retries the transient errors a recursive
 * removal can hit (ENOTEMPTY / EBUSY / EPERM while a file is still being written or listed), so
 * the assertion polls for the removal for a moment instead of reading the disk once – the
 * v0.3.81 release run failed on a bundle that a single `existsSync` still saw.
 */
async function expectGone(path: string): Promise<void> {
  const deadline = Date.now() + 2000
  while (existsSync(path) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  expect(existsSync(path)).toBe(false)
}

describe('ElectronShortcuts on Linux', () => {
  it('writes the icon, a menu entry and a Desktop copy, then confirms with the icon URL', async () => {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(h.paths.desktop, { recursive: true })
    const host = h.host('linux')
    expect(await host.pin(REQUEST)).toBe(true)
    const slug = appSlug(REQUEST.id)
    const iconPath = join(h.profile, slug, 'icon.png')
    expect(existsSync(iconPath)).toBe(true)
    expect(h.confirmed).toEqual([{ id: REQUEST.id, icon: `file://${iconPath}` }])
    // The icon came from the manifest icon, drawn through the tile document.
    expect(h.fetched).toEqual([REQUEST.iconUrl])
    expect(h.rendered).toHaveLength(1)
    expect(h.rendered[0]).toContain('data:image/png;base64,AQID')
    expect(h.rendered[0]).toContain('object-fit:cover')

    const menuEntry = join(h.paths.applications, `zenium-webapp-${slug}.desktop`)
    const text = readFileSync(menuEntry, 'utf8')
    expect(text).toContain('Name=Sketch Studio\n')
    expect(text).toContain(`Exec="/opt/Zenium/zenium" "--app=${REQUEST.url}"\n`)
    expect(text).toContain(`Icon=${iconPath}\n`)
    expect(text).toContain('StartupWMClass=zenium\n')
    expect(statSync(menuEntry).mode & 0o111).not.toBe(0)
    const desktopCopy = join(h.paths.desktop, 'Sketch Studio.desktop')
    expect(readFileSync(desktopCopy, 'utf8')).toBe(text)

    const manifest = JSON.parse(readFileSync(join(h.profile, slug, 'launcher.json'), 'utf8'))
    expect(manifest.files).toEqual([iconPath, menuEntry, desktopCopy])
    expect(manifest.directories).toEqual([])
  })

  it('leaves the Desktop alone when there is none and draws a letter tile without an icon', async () => {
    const host = h.host('linux', { icon: false })
    expect(await host.pin({ ...REQUEST, iconUrl: null, iconKind: null })).toBe(true)
    expect(existsSync(h.paths.desktop)).toBe(false)
    expect(h.rendered[0]).toContain('>S</span>')
    expect(h.rendered[0]).toContain('background:#336699')
  })

  it('falls back to the app icon when nothing can be rendered and still installs', async () => {
    const host = h.host('linux', { render: false, icon: false })
    expect(await host.pin(REQUEST)).toBe(true)
    const iconPath = join(h.profile, appSlug(REQUEST.id), 'icon.png')
    expect(existsSync(iconPath)).toBe(true)
    expect(h.confirmed).toHaveLength(1)
  })

  it('uninstalls what it wrote and nothing else, and tolerates a second uninstall', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(h.paths.applications, { recursive: true })
    const other = join(h.paths.applications, 'other.desktop')
    writeFileSync(other, '[Desktop Entry]\n')
    const host = h.host('linux')
    await host.pin(REQUEST)
    const slug = appSlug(REQUEST.id)
    await host.unpin(REQUEST.id)
    await expectGone(join(h.profile, slug))
    await expectGone(join(h.paths.applications, `zenium-webapp-${slug}.desktop`))
    expect(existsSync(other)).toBe(true)
    await expect(host.unpin(REQUEST.id)).resolves.toBeUndefined()
    await expect(host.unpin('never-installed')).resolves.toBeUndefined()
  })

  it('replaces an earlier launcher of the same app on a reinstall', async () => {
    const host = h.host('linux')
    await host.pin(REQUEST)
    await host.pin({ ...REQUEST, title: 'Sketch' })
    const slug = appSlug(REQUEST.id)
    const text = readFileSync(join(h.paths.applications, `zenium-webapp-${slug}.desktop`), 'utf8')
    expect(text).toContain('Name=Sketch\n')
    expect(h.confirmed).toHaveLength(2)
  })
})

describe('ElectronShortcuts on Windows', () => {
  it('writes an ICO and Start menu plus desktop .lnk files with the app identity', async () => {
    const host = h.host('win32')
    expect(await host.pin(REQUEST)).toBe(true)
    const slug = appSlug(REQUEST.id)
    const ico = join(h.profile, slug, 'icon.ico')
    expect(existsSync(ico)).toBe(true)
    const bytes = readFileSync(ico)
    expect(bytes.readUInt16LE(2)).toBe(1)
    expect(bytes.readUInt16LE(4)).toBe(6)
    expect(written.map((w) => w.path)).toEqual([
      join(h.paths.startMenuPrograms, LAUNCHER_FOLDER, 'Sketch Studio.lnk'),
      join(h.paths.desktop, 'Sketch Studio.lnk')
    ])
    const options = written[0].options
    expect(options.target).toBe('C:\\Program Files\\Zenium\\zenium.exe')
    expect(options.args).toBe(`--app=${REQUEST.url}`)
    expect(options.icon).toBe(ico)
    expect(options.appUserModelId).toBe(`io.github.benitbuhner.zenium.app.${slug}`)
    expect(ElectronShortcuts.appUserModelId(REQUEST.id)).toBe(options.appUserModelId)
    const manifest = JSON.parse(readFileSync(join(h.profile, slug, 'launcher.json'), 'utf8'))
    expect(manifest.files).toContain(written[0].path)
    expect(manifest.files).toContain(written[1].path)
  })
})

describe('ElectronShortcuts on macOS', () => {
  it('writes an .app bundle under ~/Applications/Zenium Apps with plist, script and ICNS', async () => {
    const host = h.host('darwin')
    expect(await host.pin(REQUEST)).toBe(true)
    const bundle = join(h.paths.userApplications, LAUNCHER_FOLDER, 'Sketch Studio.app')
    const plist = readFileSync(join(bundle, 'Contents', 'Info.plist'), 'utf8')
    expect(plist).toContain('<string>Sketch Studio</string>')
    expect(plist).toContain(
      `<string>io.github.benitbuhner.zenium.app.${appSlug(REQUEST.id)}</string>`
    )
    const script = readFileSync(join(bundle, 'Contents', 'MacOS', 'app'), 'utf8')
    // Not inside a .app bundle in this harness: the executable is run directly.
    expect(script).toBe(`#!/bin/sh\nexec '/opt/Zenium/zenium' '--app=${REQUEST.url}'\n`)
    expect(statSync(join(bundle, 'Contents', 'MacOS', 'app')).mode & 0o111).not.toBe(0)
    const icns = readFileSync(join(bundle, 'Contents', 'Resources', 'app.icns'))
    expect(icns.subarray(0, 4).toString('ascii')).toBe('icns')
    expect(icns.readUInt32BE(4)).toBe(icns.byteLength)
    // macOS tiles are drawn on the rounded square.
    expect(h.rendered[0]).toContain('border-radius:115px')
    const manifest = JSON.parse(
      readFileSync(join(h.profile, appSlug(REQUEST.id), 'launcher.json'), 'utf8')
    )
    expect(manifest.directories).toEqual([bundle])
    await host.unpin(REQUEST.id)
    await expectGone(bundle)
  })
})
