import { describe, expect, it } from 'vitest'
import {
  asarEntry,
  asarPathFor,
  bareVersion,
  binaryVersion,
  defaultUserDataDir,
  isAppMainProcess,
  judge,
  newAppProcesses,
  parseArgs,
  parseAsarHeader,
  parsePsArgs,
  parsePsComm,
  parseRange,
  parseWin32Processes,
  plistShortVersion,
  readAsarFile,
  updateErrorToast
} from './update-proof-lib.mjs'

/** An asar archive in memory, the way @electron/asar lays it out: two pickles, then the files. */
function makeAsar(files) {
  const header = { files: {} }
  const chunks = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const bytes = Buffer.from(text, 'utf8')
    header.files[name] = { size: bytes.length, offset: String(offset) }
    chunks.push(bytes)
    offset += bytes.length
  }
  const json = Buffer.from(JSON.stringify(header), 'utf8')
  const padded = Math.ceil(json.length / 4) * 4
  // The header pickle: its payload size, the string's length, the string padded to 4 bytes.
  const headerPickleSize = 4 + 4 + padded
  const head = Buffer.alloc(16)
  head.writeUInt32LE(4, 0)
  head.writeUInt32LE(headerPickleSize, 4)
  head.writeUInt32LE(4 + padded, 8)
  head.writeUInt32LE(json.length, 12)
  return Buffer.concat([head, json, Buffer.alloc(padded - json.length), ...chunks])
}

/** A `node:fs` stand-in over in-memory files (openSync / readSync / closeSync / readFileSync). */
function memoryFs(files) {
  const fds = new Map()
  let next = 3
  return {
    openSync(file) {
      if (!(file in files)) {
        const e = new Error(`ENOENT: no such file, open '${file}'`)
        e.code = 'ENOENT'
        throw e
      }
      const fd = next++
      fds.set(fd, files[file])
      return fd
    },
    readSync(fd, buffer, offset, length, position) {
      const data = fds.get(fd)
      return data.copy(buffer, offset, position, position + length)
    },
    closeSync(fd) {
      fds.delete(fd)
    },
    readFileSync(file) {
      if (!(file in files)) {
        const e = new Error(`ENOENT: no such file, open '${file}'`)
        e.code = 'ENOENT'
        throw e
      }
      return files[file].toString('utf8')
    }
  }
}

describe('asar reading', () => {
  const archive = makeAsar({
    'package.json': '{"name":"zenium","version":"0.5.81"}',
    'a.txt': 'hi'
  })
  it('parses the header and finds entries', () => {
    const { header, filesStart } = parseAsarHeader(archive)
    expect(filesStart).toBe(8 + archive.readUInt32LE(4))
    expect(asarEntry(header, 'package.json')).toEqual({ size: 36, offset: 0, unpacked: false })
    expect(asarEntry(header, 'a.txt')).toEqual({ size: 2, offset: 36, unpacked: false })
    expect(asarEntry(header, 'missing')).toBeNull()
  })
  it('reads a file by path through the io seam', () => {
    const io = memoryFs({ '/x/app.asar': archive })
    expect(readAsarFile('/x/app.asar', 'package.json', io).toString()).toBe(
      '{"name":"zenium","version":"0.5.81"}'
    )
    expect(readAsarFile('/x/app.asar', 'a.txt', io).toString()).toBe('hi')
    expect(readAsarFile('/x/app.asar', 'nope', io)).toBeNull()
  })
  it('refuses a truncated header', () => {
    expect(() => parseAsarHeader(archive.subarray(0, 20))).toThrow(/truncated/)
    expect(() => parseAsarHeader(Buffer.alloc(3))).toThrow(/too short/)
  })
})

describe('binaryVersion', () => {
  const archive = makeAsar({ 'package.json': '{"version":"0.5.81"}' })
  it('reads resources/app.asar next to the executable on Linux and Windows', () => {
    const linux = memoryFs({ '/opt/Zenium/resources/app.asar': archive })
    expect(binaryVersion('/opt/Zenium/zenium', 'linux', linux)).toEqual({
      version: '0.5.81',
      source: '/opt/Zenium/resources/app.asar'
    })
    expect(asarPathFor('C:\\P\\zenium\\zenium.exe', 'win32')).toMatch(/resources[\\/]app\.asar$/)
  })
  it('reads Contents/Resources/app.asar on macOS and falls back to Info.plist', () => {
    const mac = memoryFs({ '/Applications/Zenium.app/Contents/Resources/app.asar': archive })
    expect(
      binaryVersion('/Applications/Zenium.app/Contents/MacOS/Zenium', 'darwin', mac).version
    ).toBe('0.5.81')
    const plistOnly = memoryFs({
      '/Applications/Zenium.app/Contents/Info.plist': Buffer.from(
        '<plist><dict><key>CFBundleShortVersionString</key>\n<string>0.5.82</string></dict></plist>'
      )
    })
    expect(
      binaryVersion('/Applications/Zenium.app/Contents/MacOS/Zenium', 'darwin', plistOnly)
    ).toEqual({
      version: '0.5.82',
      source: '/Applications/Zenium.app/Contents/Info.plist'
    })
    expect(plistShortVersion('<key>CFBundleVersion</key><string>1</string>')).toBeNull()
  })
  it('names every path it tried when nothing answers', () => {
    const out = binaryVersion('/nowhere/zenium', 'linux', memoryFs({}))
    expect(out.version).toBeNull()
    expect(out.error).toMatch(/\/nowhere\/resources\/app\.asar: ENOENT/)
  })
})

describe('process records', () => {
  it('accepts the app main process only – not helpers, not the AppImage runtime, not others', () => {
    expect(
      isAppMainProcess({ pid: 1, exe: '/opt/Zenium/zenium', cmdline: ['/opt/Zenium/zenium'] })
    ).toBe(true)
    expect(
      isAppMainProcess({
        pid: 2,
        exe: '/opt/Zenium/zenium',
        cmdline: ['zenium', '--type=renderer']
      })
    ).toBe(false)
    expect(
      isAppMainProcess({ pid: 3, exe: '/home/u/zenium-0.5.80-x86_64.AppImage', cmdline: [] })
    ).toBe(false)
    expect(
      isAppMainProcess({
        pid: 4,
        exe: 'C:\\Programs\\zenium\\zenium.exe',
        cmdline: '"C:\\Programs\\zenium\\zenium.exe"'
      })
    ).toBe(true)
    expect(
      isAppMainProcess(
        { pid: 5, exe: '/Applications/Zenium.app/Contents/MacOS/Zenium', cmdline: '' },
        ['Zenium']
      )
    ).toBe(true)
    expect(isAppMainProcess({ pid: 6, exe: '/usr/bin/bash', cmdline: 'bash' })).toBe(false)
    expect(isAppMainProcess({ pid: 7, exe: '', cmdline: '' })).toBe(false)
  })
  it('finds the main processes new since the install was asked for', () => {
    const procs = [
      { pid: 10, exe: '/opt/Zenium/zenium', cmdline: [] },
      { pid: 11, exe: '/opt/Zenium/zenium', cmdline: ['--type=gpu-process'] },
      { pid: 12, exe: '/opt/Zenium/zenium', cmdline: [] }
    ]
    expect(newAppProcesses(procs, [10]).map((p) => p.pid)).toEqual([12])
  })
  it('parses ps and Win32_Process output', () => {
    expect(
      parsePsComm('  501  1 /Applications/Zenium.app/Contents/MacOS/Zenium\n 77 501 /bin/sh\n')
    ).toEqual([
      { pid: 501, ppid: 1, exe: '/Applications/Zenium.app/Contents/MacOS/Zenium' },
      { pid: 77, ppid: 501, exe: '/bin/sh' }
    ])
    expect(
      parsePsArgs(' 501 /Applications/Zenium.app/Contents/MacOS/Zenium --user-data-dir=/x\n').get(
        501
      )
    ).toBe('/Applications/Zenium.app/Contents/MacOS/Zenium --user-data-dir=/x')
    const one = parseWin32Processes(
      '{"ProcessId":4242,"ParentProcessId":1,"ExecutablePath":"C:\\\\P\\\\zenium.exe","CommandLine":"\\"C:\\\\P\\\\zenium.exe\\""}'
    )
    expect(one).toEqual([
      { pid: 4242, ppid: 1, exe: 'C:\\P\\zenium.exe', cmdline: '"C:\\P\\zenium.exe"' }
    ])
    expect(
      parseWin32Processes('[{"ProcessId":1,"ExecutablePath":null,"CommandLine":null}]')
    ).toEqual([{ pid: 1, ppid: null, exe: '', cmdline: '' }])
    expect(parseWin32Processes('not json')).toEqual([])
  })
})

describe('toasts and the verdict', () => {
  const check = {
    phase: 'available',
    mode: 'in-place',
    kind: 'nsis',
    assetName: 'zenium-0.5.81-x64-setup.exe'
  }
  const download = { phase: 'ready', error: null }
  const install = { exited: true, errorToast: null }
  const relaunched = { found: true, version: '0.5.81', exe: 'C:\\P\\zenium.exe' }
  it('picks the update flow error toast out of the others', () => {
    expect(
      updateErrorToast([{ message: 'Zenium 0.5.81 is ready – restart to update.' }])
    ).toBeNull()
    expect(
      updateErrorToast([
        { message: 'Something else' },
        {
          message:
            "Could not install the update: No update filepath provided, can't quit and install",
          kind: 'error'
        }
      ])
    ).toBe("Could not install the update: No update filepath provided, can't quit and install")
    expect(updateErrorToast([{ message: 'Update failed: the download is corrupt' }])).toMatch(
      /^Update failed/
    )
    expect(updateErrorToast(null)).toBeNull()
  })
  it('passes a complete old → new run', () => {
    expect(
      judge({ expected: '0.5.81', oldVersion: '0.5.70', check, download, install, relaunched })
    ).toEqual({
      ok: true,
      stage: 'done',
      reason: '0.5.70 → 0.5.81'
    })
  })
  it('names the first step that did not pass, with the text the user saw', () => {
    expect(judge({ expected: '0.5.81', oldVersion: '0.5.70' }).stage).toBe('check')
    expect(
      judge({
        expected: '0.5.81',
        oldVersion: '0.5.70',
        check: { phase: 'error', error: 'GitHub answered 403' }
      })
    ).toEqual({
      ok: false,
      stage: 'check',
      reason: 'check failed: GitHub answered 403'
    })
    expect(
      judge({ expected: '0.5.81', oldVersion: '0.5.81', check: { phase: 'up-to-date' } }).reason
    ).toMatch(/no update offered/)
    expect(
      judge({
        expected: '0.5.81',
        oldVersion: '0.5.70',
        check: { ...check, mode: 'manual', kind: 'unpacked' }
      }).reason
    ).toMatch(/mode "manual" \(install kind unpacked\)/)
    expect(
      judge({ expected: '0.5.81', oldVersion: '0.5.70', check: { ...check, assetName: null } })
        .reason
    ).toMatch(/no package/)
    expect(
      judge({
        expected: '0.5.81',
        oldVersion: '0.5.70',
        check,
        download: { phase: 'error', error: 'checksum mismatch' }
      })
    ).toEqual({
      ok: false,
      stage: 'download',
      reason: 'download ended in phase error: checksum mismatch'
    })
    expect(
      judge({
        expected: '0.5.81',
        oldVersion: '0.5.70',
        check,
        download,
        install: { exited: false, errorToast: 'Could not install the update: x' }
      })
    ).toEqual({ ok: false, stage: 'install', reason: 'Could not install the update: x' })
    expect(
      judge({
        expected: '0.5.81',
        oldVersion: '0.5.70',
        check,
        download,
        install: { exited: false, errorToast: null }
      }).reason
    ).toBe('the app did not quit after Restart to update / Install')
    expect(
      judge({
        expected: '0.5.81',
        oldVersion: '0.5.70',
        check,
        download,
        install: {
          exited: false,
          errorToast: null,
          windowPrompt: { kind: 'quit', count: 2 },
          besideOld: { pid: 77, version: '0.5.81' }
        }
      }).reason
    ).toBe(
      'the app did not quit after Restart to update / Install: a "quit" question (2 tabs) stood in the window; a second instance (0.5.81, pid 77) started beside it'
    )
    // The old app quit in the end (the question answered), but the new version had been
    // running beside it for seconds: on one profile it would have died on the lock.
    expect(
      judge({
        expected: '0.5.81',
        oldVersion: '0.5.70',
        check,
        download,
        install: {
          exited: true,
          exit: { code: 0, at: 60000 },
          errorToast: null,
          windowPrompt: { kind: 'quit', count: 2, answered: true },
          besideOld: { pid: 77, version: '0.5.81', at: 12000 }
        },
        relaunched
      })
    ).toEqual({
      ok: false,
      stage: 'install',
      reason:
        'a second instance (0.5.81, pid 77) started 48s before the old app quit; a "quit" question (2 tabs) stood in the window (answered) – with one profile it would have died on the single-instance lock'
    })
    // Seen within the grace of the exit: that is the relaunch itself.
    expect(
      judge({
        expected: '0.5.81',
        oldVersion: '0.5.70',
        check,
        download,
        install: {
          exited: true,
          exit: { code: 0, at: 13000 },
          errorToast: null,
          windowPrompt: { kind: 'quit', count: 2, answered: true },
          besideOld: { pid: 77, version: '0.5.81', at: 12000 }
        },
        relaunched
      }).ok
    ).toBe(true)
    expect(
      judge({
        expected: '0.5.81',
        oldVersion: '0.5.70',
        check,
        download,
        install,
        relaunched: { found: false }
      }).stage
    ).toBe('relaunch')
    expect(
      judge({
        expected: '0.5.81',
        oldVersion: '0.5.70',
        check,
        download,
        install,
        relaunched: { ...relaunched, version: '0.5.70' }
      }).reason
    ).toMatch(/runs 0\.5\.70 from C:\\P\\zenium\.exe; expected 0\.5\.81/)
    expect(
      judge({
        expected: '0.5.81',
        oldVersion: '0.5.70',
        check,
        download,
        install,
        relaunched,
        verified: { version: '0.5.70' }
      }).stage
    ).toBe('verify')
  })
})

describe('arguments and ranges', () => {
  it('parses flags, values and repeated keys', () => {
    expect(
      parseArgs(['drive', '--exe', '/x', '--label=old', '--keep', '--env', 'A=1', '--env', 'B=2'])
    ).toEqual({
      _: ['drive'],
      exe: '/x',
      label: 'old',
      keep: true,
      env: ['A=1', 'B=2']
    })
    expect(bareVersion('v0.5.81')).toBe('0.5.81')
    expect(bareVersion(' 0.5.81 ')).toBe('0.5.81')
  })
  it('reads byte ranges the way electron-updater asks for them', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=0-5000', 1000)).toEqual({ start: 0, end: 999 })
    expect(parseRange('bytes=1000-', 1000)).toEqual({ unsatisfiable: true })
    expect(parseRange('items=0-1', 1000)).toBeNull()
    expect(parseRange(undefined, 1000)).toBeNull()
  })
  it("knows where each OS keeps the app's default profile", () => {
    expect(defaultUserDataDir({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32')).toBe(
      'C:\\Users\\u\\AppData\\Roaming\\Zenium'
    )
    expect(defaultUserDataDir({ HOME: '/Users/u' }, 'darwin')).toBe(
      '/Users/u/Library/Application Support/Zenium'
    )
    expect(defaultUserDataDir({ HOME: '/home/u', XDG_CONFIG_HOME: '/tmp/x' }, 'linux')).toBe(
      '/tmp/x/Zenium'
    )
    expect(defaultUserDataDir({ HOME: '/home/u' }, 'linux')).toBe('/home/u/.config/Zenium')
  })
})
