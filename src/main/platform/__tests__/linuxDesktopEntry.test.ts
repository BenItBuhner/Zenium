import { describe, expect, it } from 'vitest'
import type { FileAssociation, LinuxConfiguration, Protocol } from 'app-builder-lib'
import type { LinuxPackager } from 'app-builder-lib/out/linuxPackager'
import { LinuxTargetHelper } from 'app-builder-lib/out/targets/LinuxTargetHelper'

/*
 * The desktop entry electron-builder writes into the Linux packages – the one
 * defaultBrowser.ts registers for `x-scheme-handler/http` and `https` (LINUX_DESKTOP_ID) – lists
 * every MIME type once, whichever Linux target of a build it is written for. This is what
 * `patches/app-builder-lib+26.15.3.patch` gives `LinuxTargetHelper.computeDesktopEntry`: it
 * used to append the file-association and `protocols` types to the configuration's own
 * `linux.mimeTypes` array (`asArray` returns an array by reference) once per target of the run,
 * so `electron-builder --linux AppImage deb` gave the deb's entry
 * `…;x-scheme-handler/http;x-scheme-handler/https;x-scheme-handler/http;x-scheme-handler/https;`
 * and `desktop-file-validate` warned "contains … more than once" – a duplication
 * .github/smoke/linux-install.mjs's checkDesktopEntry now fails on. The patch copies before
 * appending and joins each type once, in order.
 */

/** electron-builder.yml's `linux` block, the parts the desktop entry reads. */
function linuxOptions(): LinuxConfiguration {
  return {
    executableName: 'zenium',
    category: 'Network',
    mimeTypes: [
      'text/html',
      'application/xhtml+xml',
      'multipart/related',
      'image/svg+xml',
      'image/webp',
      'image/avif',
      'application/pdf'
    ],
    desktop: {
      entry: { Actions: 'new-window;new-private-window;' },
      desktopActions: {
        'new-window': { Name: 'New Window', Exec: 'zenium --new-window' },
        'new-private-window': { Name: 'New Private Window', Exec: 'zenium --private-window' }
      }
    }
  }
}

/** electron-builder.yml's `protocols` block. */
const PROTOCOLS: Protocol[] = [{ name: 'Web URL', schemes: ['http', 'https'], role: 'Viewer' }]

/**
 * The packager as computeDesktopEntry reads it: the app's names, the shared configuration and
 * the Linux options every target of the build hands back in.
 */
function packager(
  options: LinuxConfiguration,
  fileAssociations: FileAssociation[] = []
): LinuxPackager {
  const fake = {
    executableName: 'zenium',
    appInfo: { productName: 'Zenium', description: 'Zenium: a browser.' },
    info: { metadata: { desktopName: 'zenium.desktop' } },
    config: { protocols: PROTOCOLS },
    platformSpecificBuildOptions: options,
    fileAssociations
  }
  return fake as unknown as LinuxPackager
}

/** The items of the entry's `MimeType=` line, in order. */
function mimeTypes(entry: string): string[] {
  const line = /^MimeType=(.*)$/m.exec(entry)
  expect(line, entry).not.toBeNull()
  return line![1].split(';').filter(Boolean)
}

const EXEC = '/opt/Zenium/zenium %U'

describe('the Linux desktop entry lists every MIME type once (patches/app-builder-lib)', () => {
  it('writes the same MimeType line for the second target of a build as for the first', async () => {
    const options = linuxOptions()
    const helper = new LinuxTargetHelper(packager(options))
    // Two targets of one run (AppImage, then deb) read the same options object.
    const first = mimeTypes(await helper.computeDesktopEntry(options, EXEC))
    const second = mimeTypes(await helper.computeDesktopEntry(options, EXEC))
    expect(first).toEqual([
      'text/html',
      'application/xhtml+xml',
      'multipart/related',
      'image/svg+xml',
      'image/webp',
      'image/avif',
      'application/pdf',
      'x-scheme-handler/http',
      'x-scheme-handler/https'
    ])
    expect(second).toEqual(first)
    expect(new Set(second).size).toBe(second.length)
    // The configuration itself is left as written.
    expect(options.mimeTypes).toEqual(linuxOptions().mimeTypes)
  })

  it('lists a type once when both mimeTypes and a file association name it', async () => {
    const options = linuxOptions()
    const helper = new LinuxTargetHelper(
      packager(options, [
        { ext: 'pdf', mimeType: 'application/pdf' },
        { ext: 'mhtml', mimeType: 'multipart/related' }
      ])
    )
    const types = mimeTypes(await helper.computeDesktopEntry(options, EXEC))
    expect(types.filter((t) => t === 'application/pdf')).toHaveLength(1)
    expect(types.filter((t) => t === 'multipart/related')).toHaveLength(1)
    expect(types.at(-2)).toBe('x-scheme-handler/http')
    expect(types.at(-1)).toBe('x-scheme-handler/https')
  })

  it('keeps the rest of the entry as electron-builder.yml declares it', async () => {
    const options = linuxOptions()
    const helper = new LinuxTargetHelper(packager(options))
    const entry = await helper.computeDesktopEntry(options, EXEC)
    expect(entry).toContain('[Desktop Entry]\nName=Zenium\nExec=/opt/Zenium/zenium %U\n')
    expect(entry).toContain('\nIcon=zenium\n')
    expect(entry).toContain('\nStartupWMClass=zenium\n')
    expect(entry).toContain('\nActions=new-window;new-private-window;\n')
    expect(entry).toContain('\nCategories=Network;\n')
    expect(entry).toContain(
      '[Desktop Action new-window]\nName=New Window\nExec=zenium --new-window\n'
    )
  })
})
