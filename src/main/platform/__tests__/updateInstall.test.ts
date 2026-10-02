import { describe, expect, it } from 'vitest'
import {
  appImageSwapPlan,
  detectInstallKind,
  macAppBundleOf,
  macSwapScript,
  relaunchArgs,
  shellQuote,
  type InstallProbe,
  type InstallProbeFs
} from '../updateInstall'

/*
 * The install-kind decision and the swap plans behind an in-place update (Settings › Updates ›
 * Restart to update), every OS branch on this one: the file system and the process are seams,
 * so a Windows NSIS install, a translocated macOS bundle or an AppImage in a read-only folder
 * are each a few lines here.
 */

function memoryFs(spec: {
  files?: Record<string, string>
  dirs?: Record<string, string[]>
  writable?: string[]
}): InstallProbeFs {
  const files = spec.files ?? {}
  const dirs = spec.dirs ?? {}
  const writable = new Set(spec.writable ?? [])
  return {
    exists: (p) => p in files || p in dirs,
    readdir: (p) => dirs[p] ?? [],
    readFile: (p) => files[p] ?? '',
    writable: (p) => writable.has(p)
  }
}

function probe(over: Partial<InstallProbe>): InstallProbe {
  return {
    platform: 'linux',
    isPackaged: true,
    execPath: '/opt/Zenium/zenium',
    resourcesPath: '/opt/Zenium/resources',
    env: {},
    macSigned: false,
    fs: memoryFs({}),
    ...over
  }
}

describe('detectInstallKind', () => {
  it('is dev for anything not packaged, on every OS', () => {
    for (const platform of ['win32', 'darwin', 'linux'])
      expect(detectInstallKind(probe({ platform, isPackaged: false }))).toBe('dev')
  })

  describe('Windows', () => {
    const exe = 'C:\\Users\\u\\AppData\\Local\\Programs\\Zenium\\Zenium.exe'
    const resources = 'C:\\Users\\u\\AppData\\Local\\Programs\\Zenium\\resources'
    it('is nsis with the installer’s uninstaller and update config next to it', () => {
      const fs = memoryFs({
        files: { [`${resources}\\app-update.yml`]: 'provider: generic' },
        dirs: {
          'C:\\Users\\u\\AppData\\Local\\Programs\\Zenium': ['Zenium.exe', 'Uninstall Zenium.exe']
        }
      })
      expect(
        detectInstallKind(probe({ platform: 'win32', execPath: exe, resourcesPath: resources, fs }))
      ).toBe('nsis')
    })
    it('is portable from the portable launcher, unpacked without an uninstaller or config', () => {
      const fs = memoryFs({
        files: { [`${resources}\\app-update.yml`]: 'provider: generic' },
        dirs: {
          'C:\\Users\\u\\AppData\\Local\\Programs\\Zenium': ['Zenium.exe', 'Uninstall Zenium.exe']
        }
      })
      expect(
        detectInstallKind(
          probe({
            platform: 'win32',
            execPath: exe,
            resourcesPath: resources,
            env: { PORTABLE_EXECUTABLE_DIR: 'D:\\apps' },
            fs
          })
        )
      ).toBe('portable')
      const noUninstaller = memoryFs({
        files: { [`${resources}\\app-update.yml`]: 'provider: generic' },
        dirs: { 'C:\\Users\\u\\AppData\\Local\\Programs\\Zenium': ['Zenium.exe'] }
      })
      expect(
        detectInstallKind(
          probe({ platform: 'win32', execPath: exe, resourcesPath: resources, fs: noUninstaller })
        )
      ).toBe('unpacked')
      const noConfig = memoryFs({
        dirs: {
          'C:\\Users\\u\\AppData\\Local\\Programs\\Zenium': ['Zenium.exe', 'Uninstall Zenium.exe']
        }
      })
      expect(
        detectInstallKind(
          probe({ platform: 'win32', execPath: exe, resourcesPath: resources, fs: noConfig })
        )
      ).toBe('unpacked')
    })
  })

  describe('macOS', () => {
    const exe = '/Applications/Zenium.app/Contents/MacOS/Zenium'
    const resources = '/Applications/Zenium.app/Contents/Resources'
    it('is mac-adhoc for a bundle the user can rename within its folder', () => {
      const fs = memoryFs({ writable: ['/Applications/Zenium.app', '/Applications'] })
      expect(
        detectInstallKind(
          probe({ platform: 'darwin', execPath: exe, resourcesPath: resources, fs })
        )
      ).toBe('mac-adhoc')
    })
    it('is mac-unsigned when translocated, on a read-only volume or in a folder it cannot write', () => {
      const writableBoth = memoryFs({ writable: ['/Applications/Zenium.app', '/Applications'] })
      expect(
        detectInstallKind(
          probe({
            platform: 'darwin',
            execPath:
              '/private/var/folders/x/AppTranslocation/ABCD/d/Zenium.app/Contents/MacOS/Zenium',
            resourcesPath:
              '/private/var/folders/x/AppTranslocation/ABCD/d/Zenium.app/Contents/Resources',
            fs: writableBoth
          })
        )
      ).toBe('mac-unsigned')
      const dmg = memoryFs({})
      expect(
        detectInstallKind(
          probe({
            platform: 'darwin',
            execPath: '/Volumes/Zenium 0.5.70-arm64/Zenium.app/Contents/MacOS/Zenium',
            resourcesPath: '/Volumes/Zenium 0.5.70-arm64/Zenium.app/Contents/Resources',
            fs: dmg
          })
        )
      ).toBe('mac-unsigned')
      const bundleOnly = memoryFs({ writable: ['/Applications/Zenium.app'] })
      expect(
        detectInstallKind(
          probe({ platform: 'darwin', execPath: exe, resourcesPath: resources, fs: bundleOnly })
        )
      ).toBe('mac-unsigned')
    })
    it('is mac-signed only for a Developer ID build with the update config', () => {
      const fs = memoryFs({
        files: { [`${resources}/app-update.yml`]: 'provider: generic' },
        writable: ['/Applications/Zenium.app', '/Applications']
      })
      expect(
        detectInstallKind(
          probe({
            platform: 'darwin',
            execPath: exe,
            resourcesPath: resources,
            macSigned: true,
            fs
          })
        )
      ).toBe('mac-signed')
      // Signed, but no config shipped: the swap is still ours.
      expect(
        detectInstallKind(
          probe({
            platform: 'darwin',
            execPath: exe,
            resourcesPath: resources,
            macSigned: true,
            fs: memoryFs({ writable: ['/Applications/Zenium.app', '/Applications'] })
          })
        )
      ).toBe('mac-adhoc')
    })
  })

  describe('Linux', () => {
    it('is appimage for a writable AppImage in a writable folder, unpacked otherwise', () => {
      const image = '/home/u/Applications/zenium-0.5.70-x86_64.AppImage'
      const env = { APPIMAGE: image }
      expect(
        detectInstallKind(
          probe({ env, fs: memoryFs({ writable: [image, '/home/u/Applications'] }) })
        )
      ).toBe('appimage')
      expect(detectInstallKind(probe({ env, fs: memoryFs({ writable: [image] }) }))).toBe(
        'unpacked'
      )
      expect(
        detectInstallKind(probe({ env, fs: memoryFs({ writable: ['/home/u/Applications'] }) }))
      ).toBe('unpacked')
      expect(
        detectInstallKind(
          probe({
            env: { APPIMAGE: 'relative.AppImage' },
            fs: memoryFs({ writable: ['relative.AppImage', '.'] })
          })
        )
      ).toBe('unpacked')
    })
    it('is deb from the package-type marker with the update config, unpacked without', () => {
      const withBoth = memoryFs({
        files: {
          '/opt/Zenium/resources/package-type': 'deb\n',
          '/opt/Zenium/resources/app-update.yml': 'provider: generic'
        }
      })
      expect(detectInstallKind(probe({ fs: withBoth }))).toBe('deb')
      const rpm = memoryFs({
        files: {
          '/opt/Zenium/resources/package-type': 'rpm',
          '/opt/Zenium/resources/app-update.yml': 'provider: generic'
        }
      })
      expect(detectInstallKind(probe({ fs: rpm }))).toBe('unpacked')
      const noConfig = memoryFs({ files: { '/opt/Zenium/resources/package-type': 'deb' } })
      expect(detectInstallKind(probe({ fs: noConfig }))).toBe('unpacked')
      expect(detectInstallKind(probe({}))).toBe('unpacked')
    })
  })
})

describe('macAppBundleOf', () => {
  it('finds the .app an executable runs from', () => {
    expect(macAppBundleOf('/Applications/Zenium.app/Contents/MacOS/Zenium')).toBe(
      '/Applications/Zenium.app'
    )
    expect(
      macAppBundleOf(
        '/Applications/Zenium.app/Contents/Frameworks/Zenium Helper.app/Contents/MacOS/Zenium Helper'
      )
    ).toBe('/Applications/Zenium.app/Contents/Frameworks/Zenium Helper.app')
    expect(macAppBundleOf('/opt/Zenium/zenium')).toBeNull()
  })
})

describe('appImageSwapPlan', () => {
  it('keeps a renamed AppImage’s name and path', () => {
    expect(
      appImageSwapPlan(
        '/home/u/Apps/Zenium.AppImage',
        '/home/u/.cache/pending/zenium-0.5.81-x86_64.AppImage'
      )
    ).toEqual({
      destination: '/home/u/Apps/Zenium.AppImage',
      staging: '/home/u/Apps/Zenium.AppImage.zenium-update',
      removeOld: false
    })
  })
  it('puts a versioned download next to a versioned file and removes the old one', () => {
    expect(
      appImageSwapPlan(
        '/home/u/Apps/zenium-0.5.70-x86_64.AppImage',
        '/home/u/.cache/pending/zenium-0.5.81-x86_64.AppImage'
      )
    ).toEqual({
      destination: '/home/u/Apps/zenium-0.5.81-x86_64.AppImage',
      staging: '/home/u/Apps/zenium-0.5.81-x86_64.AppImage.zenium-update',
      removeOld: true
    })
  })
  it('overwrites in place when the names already match', () => {
    const plan = appImageSwapPlan(
      '/home/u/Apps/zenium-0.5.81-x86_64.AppImage',
      '/tmp/zenium-0.5.81-x86_64.AppImage'
    )
    expect(plan.destination).toBe('/home/u/Apps/zenium-0.5.81-x86_64.AppImage')
    expect(plan.removeOld).toBe(false)
  })
})

describe('relaunchArgs', () => {
  it('passes the app’s own switches on and drops a harness’s debugging ones', () => {
    expect(
      relaunchArgs([
        '/opt/Zenium/zenium',
        '--inspect=0',
        '--remote-debugging-port=0',
        '--remote-debugging-pipe',
        '--inspect-brk',
        '--no-sandbox',
        '--user-data-dir=/tmp/p',
        'https://example.com'
      ])
    ).toEqual(['--no-sandbox', '--user-data-dir=/tmp/p', 'https://example.com'])
    expect(relaunchArgs(['/opt/Zenium/zenium'])).toEqual([])
  })
})

describe('macSwapScript', () => {
  const script = macSwapScript({
    pid: 4242,
    appPath: "/Applications/Zen's Zenium.app",
    stagedAppPath: '/Users/u/Library/Caches/zenium-updater/swap/staged/Zenium.app',
    logPath: '/Users/u/Library/Caches/zenium-updater/swap/swap.log',
    relaunchArgs: ['--no-sandbox', 'https://example.com/?a=1&b=2'],
    waitSeconds: 10
  })
  it('waits for the process, swaps with a rollback, clears quarantine and opens the new app', () => {
    const lines = script.split('\n')
    expect(lines[0]).toBe('#!/bin/sh')
    expect(script).toContain('PID=4242')
    expect(script).toContain(`APP='/Applications/Zen'\\''s Zenium.app'`)
    expect(script).toContain('while kill -0 "$PID"')
    expect(script).toContain('-ge 50')
    expect(script.indexOf('mv "$APP" "$OLD"')).toBeLessThan(script.indexOf('mv "$NEW" "$APP"'))
    expect(script).toContain('restoring"; mv "$OLD" "$APP"; exit 1')
    expect(script).toContain('xattr -dr com.apple.quarantine "$APP"')
    expect(lines.at(-2)).toBe(
      `open -n '/Applications/Zen'\\''s Zenium.app' --args '--no-sandbox' 'https://example.com/?a=1&b=2'`
    )
  })
  it('opens without --args when there are none', () => {
    const bare = macSwapScript({
      pid: 1,
      appPath: '/Applications/Zenium.app',
      stagedAppPath: '/tmp/s/Zenium.app',
      logPath: '/tmp/s/swap.log',
      relaunchArgs: []
    })
    expect(bare.split('\n').at(-2)).toBe(`open -n '/Applications/Zenium.app'`)
    expect(bare).toContain('-ge 450')
  })
})

describe('shellQuote', () => {
  it('makes one word of anything', () => {
    expect(shellQuote('plain')).toBe(`'plain'`)
    expect(shellQuote(`it's "x" $HOME`)).toBe(`'it'\\''s "x" $HOME'`)
  })
})
