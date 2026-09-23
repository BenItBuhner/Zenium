import { describe, expect, it } from 'vitest'
import {
  DESKTOP_ACTIONS,
  REMOVED_PATHS,
  SCHEME_HANDLERS,
  checkDesktopEntry,
  dpkgStatus,
  isRemovedStatus,
  mimeinfoHandlers,
  parseArgs,
  parseDesktopEntry,
  parseDpkgInstallLog,
  pngSize,
  readLinuxDesktopId,
  splitList,
  waitForGone
} from './linux-install.mjs'

// The entry electron-builder 26 writes into the deb from electron-builder.yml (the MimeType
// duplication included: computeDesktop pushes the protocols' schemes into the config's own
// mimeTypes array, so the second Linux target of a build gets them twice).
const debEntry = `[Desktop Entry]
Name=Zenium
Exec=/opt/Zenium/zenium %U
Terminal=false
Type=Application
Icon=zenium
StartupWMClass=zenium
Actions=new-window;new-private-window;
Comment=Zenium: Zen Browser’s Spaces, Essentials, Glance, Split View and Compact Mode on the Blink engine.
MimeType=text/html;application/xhtml+xml;multipart/related;image/svg+xml;image/webp;image/avif;application/pdf;x-scheme-handler/http;x-scheme-handler/https;x-scheme-handler/http;x-scheme-handler/https;
Categories=Network;

[Desktop Action new-window]
Name=New Window
Exec=zenium --new-window

[Desktop Action new-private-window]
Name=New Private Window
Exec=zenium --private-window
`

const appImageEntry = `[Desktop Entry]
Name=Zenium
Exec=AppRun --no-sandbox %U
Terminal=false
Type=Application
Icon=zenium
StartupWMClass=zenium
X-AppImage-Version=0.4.10
Actions=new-window;new-private-window;
MimeType=text/html;application/pdf;x-scheme-handler/http;x-scheme-handler/https;
Categories=Network;

[Desktop Action new-window]
Name=New Window
Exec=zenium --new-window

[Desktop Action new-private-window]
Name=New Private Window
Exec=zenium --private-window
`

describe('parseArgs', () => {
  it('reads --key value pairs and bare flags', () => {
    expect(
      parseArgs(['--out', '/tmp/x', '--label', 'deb', '--verbose', '--dpkg-exit', '0'])
    ).toEqual({
      out: '/tmp/x',
      label: 'deb',
      verbose: true,
      'dpkg-exit': '0'
    })
  })

  it('ignores stray words', () => {
    expect(parseArgs(['stray', '--out', 'dir'])).toEqual({ out: 'dir' })
  })
})

describe('parseDesktopEntry', () => {
  it('groups keys under their headers and skips comments', () => {
    const groups = parseDesktopEntry(
      '# a comment\n[Desktop Entry]\nName=Zenium\nExec=a b %U\n\n[Desktop Action x]\nExec=zenium --x\n'
    )
    expect(groups['Desktop Entry']).toEqual({ Name: 'Zenium', Exec: 'a b %U' })
    expect(groups['Desktop Action x']).toEqual({ Exec: 'zenium --x' })
  })

  it('keeps the last value of a repeated key and copes with CRLF', () => {
    const groups = parseDesktopEntry('[Desktop Entry]\r\nName=One\r\nName=Two\r\n')
    expect(groups['Desktop Entry'].Name).toBe('Two')
  })
})

describe('splitList', () => {
  it('splits the ;-terminated lists of a desktop entry', () => {
    expect(splitList('a;b;')).toEqual(['a', 'b'])
    expect(splitList('a')).toEqual(['a'])
    expect(splitList(undefined)).toEqual([])
    expect(splitList(' x ; ;y')).toEqual(['x', 'y'])
  })
})

describe('checkDesktopEntry', () => {
  it('accepts the deb entry, warning about the duplicated schemes only', () => {
    const { problems, warnings, entry } = checkDesktopEntry(debEntry, {
      exec: '/opt/Zenium/zenium'
    })
    expect(problems).toEqual([])
    expect(warnings).toEqual([
      'MimeType lists x-scheme-handler/http more than once',
      'MimeType lists x-scheme-handler/https more than once'
    ])
    expect(entry.StartupWMClass).toBe('zenium')
  })

  it('accepts the entry embedded in the AppImage', () => {
    const { problems, warnings } = checkDesktopEntry(appImageEntry, { exec: 'AppRun' })
    expect(problems).toEqual([])
    expect(warnings).toEqual([])
  })

  it('wants Exec to start with the given program', () => {
    const { problems } = checkDesktopEntry(appImageEntry, { exec: '/opt/Zenium/zenium' })
    expect(problems).toEqual([
      'Exec is "AppRun --no-sandbox %U", expected it to start with /opt/Zenium/zenium'
    ])
    expect(
      checkDesktopEntry(debEntry, { exec: '/opt/Zenium/zenium-nightly' }).problems
    ).toHaveLength(1)
  })

  it('names every missing scheme handler, action and the URL placeholder', () => {
    const text = debEntry
      .replace(/^MimeType=.*$/m, 'MimeType=text/html;')
      .replace(/^Actions=.*$/m, 'Actions=new-window;')
      .replace(/^Exec=.*$/m, 'Exec=/opt/Zenium/zenium')
    const { problems } = checkDesktopEntry(text, { exec: '/opt/Zenium/zenium' })
    expect(problems).toEqual([
      'Exec carries no %U: "/opt/Zenium/zenium"',
      'MimeType lacks x-scheme-handler/http: "text/html;"',
      'MimeType lacks x-scheme-handler/https: "text/html;"',
      'Actions lacks new-private-window: "new-window;"'
    ])
  })

  it('wants an Exec under every declared action', () => {
    const text = debEntry.replace('Exec=zenium --private-window\n', '')
    expect(checkDesktopEntry(text, { exec: '/opt/Zenium/zenium' }).problems).toEqual([
      '[Desktop Action new-private-window] has no Exec'
    ])
    const noGroup = debEntry.replace(/\[Desktop Action new-window\][^[]*/, '')
    expect(checkDesktopEntry(noGroup, { exec: '/opt/Zenium/zenium' }).problems).toEqual([
      'no [Desktop Action new-window] group'
    ])
  })

  it('checks Type, Name, Icon and the Network category', () => {
    const text = debEntry
      .replace('Type=Application', 'Type=Link')
      .replace('Name=Zenium\n', 'Name=Zen\n')
      .replace('Icon=zenium', 'Icon=zen')
      .replace('Categories=Network;', 'Categories=Utility;')
    const { problems } = checkDesktopEntry(text, { exec: '/opt/Zenium/zenium' })
    expect(problems).toEqual([
      'Type is "Link"',
      'Name is "Zen", not Zenium',
      'Icon is "zen", not zenium',
      'Categories lacks Network: "Utility;"'
    ])
  })

  it('reports a file without the main group', () => {
    expect(checkDesktopEntry('[Desktop Action x]\nExec=y\n').problems).toEqual([
      'no [Desktop Entry] group'
    ])
    expect(checkDesktopEntry('').entry).toBeNull()
  })

  it('checks the schemes and actions electron-builder.yml declares', () => {
    expect(SCHEME_HANDLERS).toEqual(['x-scheme-handler/http', 'x-scheme-handler/https'])
    expect(DESKTOP_ACTIONS).toEqual(['new-window', 'new-private-window'])
  })
})

describe('readLinuxDesktopId', () => {
  it('finds the constant however it is quoted', () => {
    expect(readLinuxDesktopId("export const LINUX_DESKTOP_ID = 'zenium.desktop'\n")).toBe(
      'zenium.desktop'
    )
    expect(readLinuxDesktopId('export const LINUX_DESKTOP_ID = "zenium.desktop"')).toBe(
      'zenium.desktop'
    )
    expect(readLinuxDesktopId('// no such constant\nexport const OTHER = 1\n')).toBeNull()
  })
})

describe('pngSize', () => {
  const png = (width, height) => {
    const b = Buffer.alloc(33)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
    b.writeUInt32BE(13, 8)
    b.write('IHDR', 12, 'latin1')
    b.writeUInt32BE(width, 16)
    b.writeUInt32BE(height, 20)
    return b
  }

  it('reads the IHDR dimensions', () => {
    expect(pngSize(png(512, 512))).toEqual({ width: 512, height: 512 })
    expect(pngSize(png(16, 32))).toEqual({ width: 16, height: 32 })
  })

  it('rejects other data', () => {
    expect(pngSize(Buffer.from('GIF89a......................'))).toBeNull()
    expect(pngSize(Buffer.alloc(4))).toBeNull()
    expect(pngSize('not a buffer')).toBeNull()
    const wrongChunk = png(1, 1)
    wrongChunk.write('IDAT', 12, 'latin1')
    expect(pngSize(wrongChunk)).toBeNull()
  })
})

describe('mimeinfoHandlers', () => {
  const cache =
    '[MIME Cache]\n' +
    'text/html=google-chrome.desktop;zenium.desktop;\n' +
    'x-scheme-handler/http=google-chrome.desktop;zenium.desktop;\n' +
    'x-scheme-handler/https=zenium.desktop;\n'

  it('lists the desktop ids registered for a type', () => {
    expect(mimeinfoHandlers(cache, 'x-scheme-handler/http')).toEqual([
      'google-chrome.desktop',
      'zenium.desktop'
    ])
    expect(mimeinfoHandlers(cache, 'x-scheme-handler/https')).toEqual(['zenium.desktop'])
  })

  it('is empty for a type nobody handles', () => {
    expect(mimeinfoHandlers(cache, 'x-scheme-handler/mailto')).toEqual([])
    expect(mimeinfoHandlers('', 'text/html')).toEqual([])
  })
})

describe('dpkgStatus and isRemovedStatus', () => {
  it('normalises what dpkg-query says', () => {
    expect(dpkgStatus('installed\n', 0)).toBe('installed')
    expect(dpkgStatus('config-files', 0)).toBe('config-files')
    expect(dpkgStatus('', 1)).toBe('unknown')
    expect(dpkgStatus('installed', 1)).toBe('unknown')
  })

  it('treats the states after dpkg -r, --purge and never-installed as removed', () => {
    expect(isRemovedStatus('config-files')).toBe(true)
    expect(isRemovedStatus('not-installed')).toBe(true)
    expect(isRemovedStatus('unknown')).toBe(true)
    expect(isRemovedStatus('installed')).toBe(false)
    expect(isRemovedStatus('half-installed')).toBe(false)
    expect(isRemovedStatus('unpacked')).toBe(false)
  })
})

describe('parseDpkgInstallLog', () => {
  // What the ubuntu-24.04 runner image printed for the deb: two Depends the image does not carry, dpkg
  // leaving the package unconfigured, apt-get install -f pulling the libraries in (libsecret's
  // -common with them) and configuring the package.
  const runnerLog = [
    'Selecting previously unselected package zenium.',
    '(Reading database ... 202879 files and directories currently installed.)',
    'Preparing to unpack .../dist/zenium_0.4.12_amd64.deb ...',
    'Unpacking zenium (0.4.12) ...',
    'dpkg: dependency problems prevent configuration of zenium:',
    ' zenium depends on libnotify4; however:',
    '  Package libnotify4 is not installed.',
    ' zenium depends on libsecret-1-0; however:',
    '  Package libsecret-1-0 is not installed.',
    '',
    'dpkg: error processing package zenium (--install):',
    ' dependency problems - leaving unconfigured',
    'Processing triggers for desktop-file-utils (0.27-2build1) ...',
    'Errors were encountered while processing:',
    ' zenium',
    'Selecting previously unselected package libnotify4:amd64.',
    '(Reading database ... 203025 files and directories currently installed.)',
    'Preparing to unpack .../libnotify4_0.8.3-1build2_amd64.deb ...',
    'Unpacking libnotify4:amd64 (0.8.3-1build2) ...',
    'Selecting previously unselected package libsecret-common.',
    'Selecting previously unselected package libsecret-1-0:amd64.',
    'Setting up libnotify4:amd64 (0.8.3-1build2) ...',
    'Setting up zenium (0.4.12) ...',
    'update-alternatives: using /opt/Zenium/zenium to provide /usr/bin/zenium (zenium) in auto mode'
  ].join('\n')

  it('names the unmet Depends and what apt-get install -f pulled in, the package itself excepted', () => {
    expect(parseDpkgInstallLog(runnerLog)).toEqual({
      unmet: ['libnotify4', 'libsecret-1-0'],
      pulledIn: ['libnotify4:amd64', 'libsecret-common', 'libsecret-1-0:amd64']
    })
  })

  it('is empty for an install dpkg configured outright', () => {
    const clean = [
      'Selecting previously unselected package zenium.',
      'Unpacking zenium (0.4.12) ...',
      'Setting up zenium (0.4.12) ...',
      'Processing triggers for desktop-file-utils (0.27-2build1) ...'
    ].join('\n')
    expect(parseDpkgInstallLog(clean)).toEqual({ unmet: [], pulledIn: [] })
    expect(parseDpkgInstallLog('')).toEqual({ unmet: [], pulledIn: [] })
    expect(parseDpkgInstallLog(null)).toEqual({ unmet: [], pulledIn: [] })
  })

  it("only reads the named package's Depends and lists each one once", () => {
    const twice = [
      ' zenium depends on libnotify4; however:',
      ' other depends on libfoo; however:',
      ' zenium depends on libnotify4; however:',
      'Selecting previously unselected package zenium:amd64.'
    ].join('\n')
    expect(parseDpkgInstallLog(twice)).toEqual({ unmet: ['libnotify4'], pulledIn: [] })
    expect(parseDpkgInstallLog(twice, 'other')).toEqual({
      unmet: ['libfoo'],
      pulledIn: ['zenium:amd64']
    })
  })
})

describe('waitForGone', () => {
  const clock = () => {
    let t = 0
    return {
      now: () => t,
      sleep: async (ms) => {
        t += ms
      }
    }
  }

  it('returns at once when nothing is there', async () => {
    const { now, sleep } = clock()
    const r = await waitForGone(['/a', '/b'], { exists: () => false, now, sleep })
    expect(r).toEqual({ left: [], waitedMs: 0 })
  })

  it('polls until the paths disappear', async () => {
    const { now, sleep } = clock()
    let polls = 0
    const exists = (p) => {
      polls++
      return p === '/slow' && now() < 1000
    }
    const r = await waitForGone(['/gone', '/slow'], {
      exists,
      now,
      sleep,
      intervalMs: 250,
      timeoutMs: 5000
    })
    expect(r).toEqual({ left: [], waitedMs: 1000 })
    expect(polls).toBe(10)
  })

  it('gives up at the deadline and names what is left', async () => {
    const { now, sleep } = clock()
    const r = await waitForGone(['/stuck', '/fine'], {
      exists: (p) => p === '/stuck',
      now,
      sleep,
      intervalMs: 300,
      timeoutMs: 1000
    })
    expect(r.left).toEqual(['/stuck'])
    expect(r.waitedMs).toBe(1200)
  })

  it('covers every footprint of the deb and its maintainer scripts', () => {
    expect(REMOVED_PATHS).toEqual([
      '/opt/Zenium',
      '/usr/share/applications/zenium.desktop',
      '/usr/share/icons/hicolor/512x512/apps/zenium.png',
      '/usr/bin/zenium',
      '/etc/alternatives/zenium',
      '/usr/bin/zen-chromium',
      '/etc/apparmor.d/zenium'
    ])
  })
})
