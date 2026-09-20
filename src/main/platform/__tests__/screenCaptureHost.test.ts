import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getSources, fromFrame } = vi.hoisted(() => ({ getSources: vi.fn(), fromFrame: vi.fn() }))
vi.mock('electron', () => ({
  desktopCapturer: { getSources },
  webContents: { fromFrame }
}))

import type { Session, WebContents } from 'electron'
import { ElectronScreenCapture } from '../screenCapture'
import type { ElectronTabViewHost } from '../views'
import type {
  ScreenCaptureAnswer,
  ScreenCaptureRequestInit,
  ScreenCaptureService
} from '../../../core/screenCapture'

/** A desktopCapturer source with an image whose emptiness and JPEG we control. */
function source(id: string, name: string, opts: { empty?: boolean } = {}): unknown {
  return {
    id,
    name,
    thumbnail: {
      isEmpty: () => opts.empty ?? false,
      toJPEG: () => Buffer.from(`jpeg:${id}`)
    },
    appIcon: { isEmpty: () => true, toDataURL: () => '' }
  }
}

function host(): ElectronScreenCapture {
  return new ElectronScreenCapture(
    {} as ElectronTabViewHost,
    (() => ({})) as unknown as () => ScreenCaptureService
  )
}

/** The `types` of each getSources call that carried options (a stricter, order-preserving view). */
function typeArgs(fn: typeof getSources): string[][] {
  return fn.mock.calls
    .map((call) => (call[0] as { types: string[] } | undefined)?.types)
    .filter((types): types is string[] => Array.isArray(types))
}

beforeEach(() => {
  getSources.mockReset()
  fromFrame.mockReset()
})

/** The two stages of one page's call, with a picker whose answers the test scripts. */
function stages(): {
  host: ElectronScreenCapture
  wc: WebContents
  asked: ScreenCaptureRequestInit[]
  answers: ScreenCaptureAnswer[]
  clock: { now: number }
  /** Run the engine's display-media request for the page; resolves with what the engine got. */
  displayMedia(audioRequested?: boolean): Promise<Electron.Streams>
} {
  const asked: ScreenCaptureRequestInit[] = []
  const answers: ScreenCaptureAnswer[] = []
  const clock = { now: 1_000 }
  const wc = { id: 7 } as WebContents
  const frame = { url: 'https://meet.example/room' }
  const page = { tag: 'main frame of tab-1' }
  const tabView = { isDestroyed: () => false, webContents: { mainFrame: page } }
  const views = {
    tabIdForWebContents: (target: WebContents) => (target === wc ? 'tab-1' : undefined),
    viewForTab: (tabId: string) => (tabId === 'tab-1' ? tabView : undefined)
  } as unknown as ElectronTabViewHost
  const service = {
    request: async (init: ScreenCaptureRequestInit): Promise<ScreenCaptureAnswer> => {
      asked.push(init)
      return answers.shift() ?? { sourceId: null, audio: false }
    }
  } as unknown as ScreenCaptureService
  const host = new ElectronScreenCapture(
    views,
    () => service,
    () => clock.now
  )
  let handler: ((request: unknown, callback: (streams: Electron.Streams) => void) => void) | null =
    null
  host.attach({
    setDisplayMediaRequestHandler: (h: typeof handler) => {
      handler = h
    }
  } as unknown as Session)
  fromFrame.mockImplementation((f: unknown) => (f === frame ? wc : undefined))
  return {
    host,
    wc,
    asked,
    answers,
    clock,
    displayMedia: (audioRequested = false) =>
      new Promise((resolve) => {
        handler!(
          { frame, securityOrigin: 'https://meet.example', videoRequested: true, audioRequested },
          resolve
        )
      })
  }
}

describe('ElectronScreenCapture permission stage', () => {
  it('runs the picker with the audio the page announced and hands the pick to the engine without asking again', async () => {
    const s = stages()
    s.answers.push({ sourceId: 'screen:0:0', audio: true })
    s.host.intent(s.wc, true)
    await expect(s.host.permission(s.wc, 'tab-1', 'https://meet.example/room')).resolves.toBe(true)
    expect(s.asked).toEqual([{ tabId: 'tab-1', url: 'https://meet.example/room', audio: true }])
    // The display-media stage: the engine gets the picked screen with loopback audio; one ask.
    const streams = await s.displayMedia(true)
    expect(streams).toEqual({ video: { id: 'screen:0:0', name: '' }, audio: 'loopback' })
    expect(s.asked).toHaveLength(1)
  })

  it('a cancelled picker refuses at the permission stage (NotAllowedError) and leaves nothing behind', async () => {
    const s = stages()
    await expect(s.host.permission(s.wc, 'tab-1', 'https://meet.example/room')).resolves.toBe(false)
    expect(s.asked).toEqual([{ tabId: 'tab-1', url: 'https://meet.example/room', audio: false }])
    // Were the engine to ask anyway, the picker would run afresh rather than reuse a refusal.
    s.answers.push({ sourceId: null, audio: false })
    expect(await s.displayMedia()).toEqual({})
    expect(s.asked).toHaveLength(2)
  })

  it('an announcement is consumed once and expires; without one the picker offers no audio', async () => {
    const s = stages()
    s.answers.push(
      { sourceId: 'screen:0:0', audio: false },
      { sourceId: 'screen:0:0', audio: false }
    )
    s.host.intent(s.wc, true)
    s.clock.now += 11_000
    await s.host.permission(s.wc, 'tab-1', 'https://meet.example/room')
    await s.host.permission(s.wc, 'tab-1', 'https://meet.example/room')
    expect(s.asked.map((a) => a.audio)).toEqual([false, false])
  })

  it('a tab pick carries the tab audio when the page asked for it, in the announcement or the request', async () => {
    const s = stages()
    s.answers.push({ sourceId: 'tab:tab-1', audio: false })
    s.host.intent(s.wc, true)
    await s.host.permission(s.wc, 'tab-1', 'https://meet.example/room')
    // Electron's request did not mention audio; the page's announcement did.
    const streams = await s.displayMedia(false)
    expect(streams).toMatchObject({ audio: { tag: 'main frame of tab-1' }, enableLocalEcho: true })
    expect(streams.video).toEqual({ tag: 'main frame of tab-1' })
  })

  it('a call that reaches the display-media stage with no answer waiting still gets the picker', async () => {
    const s = stages()
    s.answers.push({ sourceId: 'window:3:0', audio: false })
    const streams = await s.displayMedia(true)
    expect(s.asked).toEqual([{ tabId: 'tab-1', url: 'https://meet.example', audio: true }])
    expect(streams).toEqual({ video: { id: 'window:3:0', name: '' } })
  })

  it('a stored answer older than its window is not reused', async () => {
    const s = stages()
    s.answers.push(
      { sourceId: 'screen:0:0', audio: false },
      { sourceId: 'window:3:0', audio: false }
    )
    await s.host.permission(s.wc, 'tab-1', 'https://meet.example/room')
    s.clock.now += 31_000
    const streams = await s.displayMedia()
    expect(streams).toEqual({ video: { id: 'window:3:0', name: '' } })
    expect(s.asked).toHaveLength(2)
  })
})

describe('ElectronScreenCapture.sources', () => {
  it('enumerates each type on its own so a failing window pass still returns the screens', async () => {
    getSources.mockImplementation(async (options?: { types: string[] }) => {
      if (options?.types[0] === 'window') throw new Error('no window manager')
      if (options?.types[0] === 'screen') return [source('screen:0:0', 'Entire Screen')]
      return []
    })
    const out = await host().sources(['screen', 'window'])
    // One getSources per type, each with only its own type (not both at once).
    expect(typeArgs(getSources)).toEqual([['screen'], ['window']])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 'screen:0:0', kind: 'screen', name: 'Entire screen' })
    expect(out[0].thumbnail).toMatch(/^data:image\/jpeg;base64,/)
  })

  it('names a lone screen "Entire screen" and numbers several; windows keep their names', async () => {
    getSources.mockImplementation(async (options?: { types: string[] }) => {
      if (options?.types[0] === 'screen')
        return [source('screen:0:0', 'Entire Screen'), source('screen:1:0', 'Screen 2')]
      return [source('window:12:0', 'Notes', { empty: true })]
    })
    const out = await host().sources(['screen', 'window'])
    // Chrome's own name is "Entire Screen"; Zenium lowercases the S to match its picker copy.
    expect(out.filter((s) => s.kind === 'screen').map((s) => s.name)).toEqual([
      'Entire screen',
      'Screen 2'
    ])
    const window = out.find((s) => s.kind === 'window')
    expect(window).toMatchObject({ id: 'window:12:0', name: 'Notes', thumbnail: null })
  })

  it('systemAudio is offered on Windows only', () => {
    const original = process.platform
    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      expect(host().systemAudio()).toBe(true)
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
      expect(host().systemAudio()).toBe(false)
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true })
    }
  })
})
