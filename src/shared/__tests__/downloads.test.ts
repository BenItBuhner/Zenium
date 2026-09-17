import { describe, expect, it } from 'vitest'
import type { DownloadItem } from '../types'
import {
  SpeedEstimator,
  aggregateProgress,
  classifyDownloadDanger,
  downloadStatus,
  extensionOf,
  fileGlyphFor,
  filterDownloads,
  formatRemaining,
  groupDownloadsByDay,
  migrateDownloads,
  needsDangerDecision,
  safeFilename,
  sanitizeDownloadSettings,
  secondsRemaining,
  splitExtension,
  uniqueName
} from '../downloads'

function item(patch: Partial<DownloadItem>): DownloadItem {
  return {
    id: 'dl_1',
    url: 'https://example.com/a.bin',
    urlChain: ['https://example.com/a.bin'],
    referrer: '',
    filename: 'a.bin',
    savePath: '/tmp/a.bin',
    mimeType: 'application/octet-stream',
    totalBytes: 100,
    receivedBytes: 0,
    bytesPerSecond: 0,
    state: 'completed',
    canResume: false,
    danger: 'safe',
    startedAt: 0,
    ...patch
  }
}

describe('file names', () => {
  it('splits extensions, keeping tarballs and dotfiles whole', () => {
    expect(splitExtension('report.pdf')).toEqual(['report', '.pdf'])
    expect(splitExtension('archive.tar.gz')).toEqual(['archive', '.tar.gz'])
    expect(splitExtension('README')).toEqual(['README', ''])
    expect(splitExtension('.env')).toEqual(['.env', ''])
    expect(extensionOf('Setup.EXE')).toBe('exe')
    expect(extensionOf('archive.tar.gz')).toBe('gz')
  })

  it('uniquifies Chrome style with a space before the counter', () => {
    const taken = new Set(['report.pdf', 'report (1).pdf'])
    expect(uniqueName('report.pdf', (n) => taken.has(n))).toBe('report (2).pdf')
    expect(uniqueName('free.pdf', (n) => taken.has(n))).toBe('free.pdf')
    const tars = new Set(['a.tar.gz'])
    expect(uniqueName('a.tar.gz', (n) => tars.has(n))).toBe('a (1).tar.gz')
    const bare = new Set(['README', 'README (1)'])
    expect(uniqueName('README', (n) => bare.has(n))).toBe('README (2)')
  })

  it('strips path separators and control characters from suggested names', () => {
    expect(safeFilename('../../etc/passwd')).toBe('.._.._etc_passwd')
    expect(safeFilename('a\u0000b.txt')).toBe('ab.txt')
    expect(safeFilename('   ')).toBe('download')
    expect(safeFilename('..')).toBe('download')
  })
})

describe('danger table', () => {
  it('flags executables, scripts, installers and disk images', () => {
    for (const name of [
      'setup.exe',
      'Setup.MSI',
      'app.msix',
      'run.bat',
      'run.cmd',
      'x.com',
      'saver.scr',
      'a.pif',
      'script.js',
      'script.jse',
      'm.vbs',
      'm.vbe',
      'p.ps1',
      'w.wsf',
      'h.hta',
      'tool.jar',
      'app.dmg',
      'app.pkg',
      'thing.app',
      'game.apk',
      'pkg.deb',
      'pkg.rpm',
      'install.sh',
      'installer.run',
      'disc.iso',
      'disc.img',
      'link.lnk',
      'site.url',
      'tweak.reg',
      'help.chm'
    ]) {
      expect(classifyDownloadDanger(name), name).toBe('dangerous')
    }
  })

  it('keeps documents, media and archives safe', () => {
    for (const name of [
      'report.pdf',
      'photo.jpg',
      'song.mp3',
      'clip.mp4',
      'archive.zip',
      'source.tar.gz',
      'notes.txt',
      'page.html',
      'data.json',
      'README'
    ]) {
      expect(classifyDownloadDanger(name), name).toBe('safe')
    }
  })

  it('has an uncommon tier for loadable but rare types', () => {
    expect(classifyDownloadDanger('ext.crx')).toBe('uncommon')
    expect(classifyDownloadDanger('lib.dll')).toBe('uncommon')
    expect(classifyDownloadDanger('tool.py')).toBe('uncommon')
  })

  it('falls back to the MIME type only when the name has no extension', () => {
    expect(classifyDownloadDanger('download', 'application/x-msdownload')).toBe('dangerous')
    expect(classifyDownloadDanger('notes.txt', 'application/x-msdownload')).toBe('safe')
    expect(classifyDownloadDanger('download', 'text/plain')).toBe('safe')
  })

  it('only completed undecided files ask for a decision', () => {
    expect(needsDangerDecision(item({ danger: 'dangerous' }))).toBe(true)
    expect(needsDangerDecision(item({ danger: 'dangerous', dangerDecision: 'kept' }))).toBe(false)
    expect(needsDangerDecision(item({ danger: 'dangerous', state: 'progressing' }))).toBe(false)
    expect(needsDangerDecision(item({ danger: 'safe' }))).toBe(false)
  })
})

describe('file glyphs', () => {
  it('prefers the MIME family, then the extension', () => {
    expect(fileGlyphFor('x.bin', 'image/png')).toBe('image')
    expect(fileGlyphFor('x.bin', 'video/mp4')).toBe('video')
    expect(fileGlyphFor('x.bin', 'audio/mpeg')).toBe('audio')
    expect(fileGlyphFor('a.zip', 'application/octet-stream')).toBe('archive')
    expect(fileGlyphFor('a.pdf', 'application/pdf')).toBe('text')
    expect(fileGlyphFor('setup.exe', 'application/octet-stream')).toBe('package')
    expect(fileGlyphFor('main.ts', '')).toBe('code')
    expect(fileGlyphFor('mystery', 'application/octet-stream')).toBe('file')
  })
})

describe('speed and time remaining', () => {
  it('needs two samples and then tracks a steady rate', () => {
    const s = new SpeedEstimator()
    expect(s.sample(0, 0)).toBe(0)
    expect(s.sample(1_000_000, 1000)).toBe(1_000_000)
    expect(s.sample(2_000_000, 2000)).toBe(1_000_000)
  })

  it('smooths a burst instead of jumping to it', () => {
    const s = new SpeedEstimator(1500)
    s.sample(0, 0)
    s.sample(1_000_000, 1000)
    const burst = s.sample(11_000_000, 1250)
    expect(burst).toBeGreaterThan(1_000_000)
    expect(burst).toBeLessThan(10_000_000)
  })

  it('weights a sample after a long silence heavily', () => {
    const s = new SpeedEstimator(1500)
    s.sample(0, 0)
    s.sample(1_000_000, 1000)
    const after = s.sample(1_100_000, 11_000)
    expect(after).toBeLessThan(50_000)
  })

  it('restarts after a rewind or a reset', () => {
    const s = new SpeedEstimator()
    s.sample(0, 0)
    s.sample(5000, 1000)
    expect(s.sample(100, 2000)).toBe(0)
    s.reset(100, 3000)
    expect(s.bytesPerSecond).toBe(0)
    expect(s.sample(1100, 4000)).toBe(1000)
  })

  it('computes and phrases the time left', () => {
    expect(secondsRemaining(50, 100, 10)).toBe(5)
    expect(secondsRemaining(50, 0, 10)).toBeNull()
    expect(secondsRemaining(50, 100, 0)).toBeNull()
    expect(formatRemaining(null)).toBe('')
    expect(formatRemaining(1)).toBe('1 sec left')
    expect(formatRemaining(30)).toBe('30 secs left')
    expect(formatRemaining(60)).toBe('1 min left')
    expect(formatRemaining(150)).toBe('3 mins left')
    expect(formatRemaining(7200)).toBe('2 hours left')
    expect(formatRemaining(200_000)).toBe('2 days left')
  })
})

describe('aggregate progress', () => {
  it('is idle without active downloads', () => {
    expect(aggregateProgress([item({ state: 'completed' })])).toEqual({ mode: 'idle', value: 0 })
    expect(aggregateProgress([])).toEqual({ mode: 'idle', value: 0 })
  })

  it('sums bytes across active downloads', () => {
    const a = item({ state: 'progressing', receivedBytes: 50, totalBytes: 100 })
    const b = item({ state: 'progressing', receivedBytes: 100, totalBytes: 300 })
    expect(aggregateProgress([a, b, item({ state: 'completed' })])).toEqual({
      mode: 'normal',
      value: 150 / 400
    })
  })

  it('is paused only when every active download is paused', () => {
    const a = item({ state: 'paused', receivedBytes: 50, totalBytes: 100 })
    const b = item({ state: 'progressing', receivedBytes: 50, totalBytes: 100 })
    expect(aggregateProgress([a]).mode).toBe('paused')
    expect(aggregateProgress([a, b]).mode).toBe('normal')
  })

  it('goes indeterminate when a total is unknown', () => {
    const a = item({ state: 'progressing', receivedBytes: 50, totalBytes: 0 })
    expect(aggregateProgress([a])).toEqual({ mode: 'indeterminate', value: 0 })
  })

  it('shows an undismissed failure as an error once nothing is active', () => {
    const failed = item({ state: 'interrupted' })
    expect(aggregateProgress([failed], { undismissedFailure: true }).mode).toBe('error')
    const busy = item({ state: 'progressing', receivedBytes: 1, totalBytes: 2 })
    expect(aggregateProgress([failed, busy], { undismissedFailure: true }).mode).toBe('normal')
  })
})

describe('migration', () => {
  it('upgrades a v1 record and interrupts anything that was in flight', () => {
    const v1 = {
      version: 1,
      items: [
        {
          id: 'dl_a',
          url: 'https://x.test/setup.exe',
          filename: 'setup.exe',
          savePath: '/dl/setup.exe',
          totalBytes: 10,
          receivedBytes: 10,
          state: 'completed',
          startedAt: 5,
          mimeType: 'application/octet-stream'
        },
        {
          id: 'dl_b',
          url: 'https://x.test/big.zip',
          filename: 'big.zip',
          savePath: '/dl/big.zip',
          totalBytes: 100,
          receivedBytes: 40,
          state: 'progressing',
          startedAt: 6,
          mimeType: 'application/zip'
        }
      ]
    }
    const [a, b] = migrateDownloads(v1)
    expect(a).toMatchObject({
      id: 'dl_a',
      urlChain: ['https://x.test/setup.exe'],
      referrer: '',
      bytesPerSecond: 0,
      state: 'completed',
      canResume: false,
      danger: 'dangerous',
      dangerDecision: 'kept',
      endedAt: 5
    })
    expect(b).toMatchObject({
      id: 'dl_b',
      state: 'interrupted',
      interruptReason: 'network',
      canResume: true,
      danger: 'safe'
    })
    expect(b.dangerDecision).toBeUndefined()
  })

  it('keeps v2 fields, drops junk and duplicate ids', () => {
    const v2 = {
      version: 2,
      items: [
        item({
          id: 'dl_c',
          state: 'interrupted',
          canResume: true,
          interruptReason: 'server',
          etag: '"abc"',
          lastModified: 'Tue, 01 Jan 2030 00:00:00 GMT',
          danger: 'uncommon',
          dangerDecision: 'discarded',
          opened: true,
          endedAt: 9
        }),
        item({ id: 'dl_c' }),
        { nonsense: true },
        null,
        { id: '' }
      ]
    }
    const items = migrateDownloads(v2)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'dl_c',
      canResume: true,
      interruptReason: 'server',
      etag: '"abc"',
      danger: 'uncommon',
      dangerDecision: 'discarded',
      opened: true,
      endedAt: 9
    })
  })

  it('does not warn retroactively about a v2 dangerous file that is still undecided', () => {
    const [x] = migrateDownloads({ version: 2, items: [item({ danger: 'dangerous' })] })
    expect(x.dangerDecision).toBeUndefined()
  })

  it('returns nothing for unreadable documents', () => {
    expect(migrateDownloads(null)).toEqual([])
    expect(migrateDownloads({ version: 2 })).toEqual([])
    expect(migrateDownloads('x')).toEqual([])
  })
})

describe('settings', () => {
  it('fills defaults and ignores wrong types', () => {
    expect(sanitizeDownloadSettings(undefined)).toEqual({
      location: '',
      showWhenDone: true,
      notifyOnComplete: true,
      alwaysShowButton: false
    })
    expect(
      sanitizeDownloadSettings({
        location: '/home/me/Files',
        showWhenDone: false,
        notifyOnComplete: 'yes' as unknown as boolean,
        alwaysShowButton: true
      })
    ).toEqual({
      location: '/home/me/Files',
      showWhenDone: false,
      notifyOnComplete: true,
      alwaysShowButton: true
    })
  })
})

describe('page helpers', () => {
  it('groups by local day, newest first, with Chrome labels', () => {
    const now = new Date(2030, 5, 15, 12).getTime()
    const today = item({ id: 't', startedAt: new Date(2030, 5, 15, 9).getTime() })
    const yesterday = item({ id: 'y', startedAt: new Date(2030, 5, 14, 23).getTime() })
    const older = item({ id: 'o', startedAt: new Date(2030, 4, 1).getTime() })
    const groups = groupDownloadsByDay([older, today, yesterday], now)
    expect(groups.map((g) => g.label.split(' ')[0])).toEqual(['Today', 'Yesterday', 'May'])
    expect(groups[0].items).toEqual([today])
  })

  it('filters by name and url', () => {
    const items = [
      item({ id: '1', filename: 'Report.pdf' }),
      item({ id: '2', url: 'https://cats.example/x' })
    ]
    expect(filterDownloads(items, 'report').map((i) => i.id)).toEqual(['1'])
    expect(filterDownloads(items, 'CATS').map((i) => i.id)).toEqual(['2'])
    expect(filterDownloads(items, '  ')).toEqual(items)
  })
})

describe('status line', () => {
  const mb = 1024 * 1024
  it('shows progress with the time left while downloading', () => {
    expect(
      downloadStatus(
        item({
          state: 'progressing',
          receivedBytes: 2.3 * mb,
          totalBytes: 100 * mb,
          bytesPerSecond: 2 * mb
        })
      )
    ).toEqual({ text: '2.3 MB of 100 MB · 49 secs left', tone: 'muted' })
    expect(
      downloadStatus(item({ state: 'progressing', receivedBytes: 5 * mb, totalBytes: 0 }))
    ).toEqual({
      text: '5 MB',
      tone: 'muted'
    })
    expect(
      downloadStatus(item({ state: 'progressing', receivedBytes: 0, totalBytes: mb }))
    ).toEqual({
      text: '0 B of 1 MB',
      tone: 'muted'
    })
  })

  it('names paused, cancelled and failed transfers', () => {
    expect(
      downloadStatus(item({ state: 'paused', receivedBytes: mb, totalBytes: 4 * mb })).text
    ).toBe('Paused · 1 MB of 4 MB')
    expect(downloadStatus(item({ state: 'cancelled' })).text).toBe('Cancelled')
    expect(downloadStatus(item({ state: 'interrupted', interruptReason: 'network' }))).toEqual({
      text: 'Failed - Network error',
      tone: 'danger'
    })
    expect(downloadStatus(item({ state: 'interrupted' })).text).toBe(
      'Failed - Something went wrong'
    )
  })

  it('describes finished files, including dangerous ones awaiting a decision', () => {
    expect(downloadStatus(item({ totalBytes: 100 * mb })).text).toBe('Done · 100 MB')
    expect(downloadStatus(item({ totalBytes: 0 })).text).toBe('Done')
    expect(downloadStatus(item({ filename: 'setup.exe', danger: 'dangerous' }))).toEqual({
      text: 'This file may be dangerous',
      tone: 'warn'
    })
    expect(downloadStatus(item({ filename: 'a.crx', danger: 'uncommon' })).text).toBe(
      'This file type is not commonly downloaded'
    )
    expect(downloadStatus(item({ danger: 'dangerous', dangerDecision: 'kept' })).text).toBe(
      'Done · 100 B'
    )
    expect(downloadStatus(item({ danger: 'dangerous', dangerDecision: 'discarded' })).text).toBe(
      'Removed'
    )
  })
})
