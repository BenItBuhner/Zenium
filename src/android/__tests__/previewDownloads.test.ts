// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPreviewDownloads, PREVIEW_DOWNLOAD_EVENT } from '../previewDownloads'
import type { PreviewDownloadSpec } from '../previewSpec'

interface Emitted {
  name: string
  payload: Record<string, unknown>
}

/** The stand-in downloader's events as the core would receive them, with the handlers it answers. */
function stage(): { events: Emitted[]; handlers: ReturnType<typeof createPreviewDownloads> } {
  const events: Emitted[] = []
  const handlers = createPreviewDownloads(
    () => ({
      hostEvent: (name, json) => {
        events.push({ name, payload: JSON.parse(json) as Record<string, unknown> })
      }
    }),
    '/storage/emulated/0/Download'
  )
  return { events, handlers }
}

const spec = (over: Partial<PreviewDownloadSpec>): PreviewDownloadSpec => ({
  filename: 'firmware.bin',
  url: 'https://downloads.example.com/firmware.bin',
  mimeType: 'application/octet-stream',
  totalBytes: 1000,
  receivedBytes: 400,
  bytesPerSecond: 100,
  paused: false,
  error: null,
  deleted: false,
  private: false,
  ...over
})

/** Announce a spec and bind it as the core would, returning the transfer's token. */
function start(stageResult: ReturnType<typeof stage>, s: PreviewDownloadSpec, id = 'd1'): string {
  window.dispatchEvent(new CustomEvent(PREVIEW_DOWNLOAD_EVENT, { detail: s }))
  const started = stageResult.events.at(-1)
  expect(started?.name).toBe('download.started')
  const token = String(started?.payload['token'])
  stageResult.handlers['download.bind']({ token, id })
  return token
}

const interruptions = (events: Emitted[]): Emitted[] =>
  events.filter((e) => e.name === 'download.progress' && e.payload['state'] === 'interrupted')

describe('createPreviewDownloads: the downloader retrying its own network failure (HB-43)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('announces each interruption with the next attempt 2, 4, then 8 s on, and plays on once the failures run out', () => {
    const s = stage()
    start(s, spec({ error: 'network-timeout', retrying: 2 }))

    let blips = interruptions(s.events)
    expect(blips).toHaveLength(1)
    expect(blips[0].payload).toMatchObject({
      state: 'interrupted',
      error: 'network-timeout',
      canResume: true,
      receivedBytes: 400,
      autoResumeAt: 1_000_000 + 2000
    })
    expect(s.events.some((e) => e.name === 'download.done')).toBe(false)

    vi.advanceTimersByTime(2000)
    blips = interruptions(s.events)
    expect(blips).toHaveLength(2)
    expect(blips[1].payload['autoResumeAt']).toBe(1_002_000 + 4000)

    vi.advanceTimersByTime(4000)
    blips = interruptions(s.events)
    expect(blips).toHaveLength(3)
    expect(blips[2].payload['autoResumeAt']).toBe(1_006_000 + 8000)

    // The third attempt gets through: the transfer plays on from its 400 bytes and completes.
    vi.advanceTimersByTime(8000)
    expect(interruptions(s.events)).toHaveLength(3)
    vi.advanceTimersByTime(7000)
    const done = s.events.find((e) => e.name === 'download.done')
    expect(done?.payload).toMatchObject({ state: 'completed', receivedBytes: 1000 })
  })

  it('gives up after the third attempt fails: the fourth failure is the final interruption, Resume left to the user', () => {
    const s = stage()
    start(s, spec({ error: 'network-disconnected', retrying: 5 }))
    vi.advanceTimersByTime(2000 + 4000 + 8000)
    expect(interruptions(s.events)).toHaveLength(3)
    const done = s.events.find((e) => e.name === 'download.done')
    expect(done?.payload).toMatchObject({
      state: 'interrupted',
      error: 'network-disconnected',
      canResume: true,
      receivedBytes: 400
    })
  })

  it('a failure that is not a network one is final at once, whatever retrying says', () => {
    const s = stage()
    start(s, spec({ error: 'file-no-space', retrying: 3 }))
    expect(interruptions(s.events)).toHaveLength(0)
    expect(s.events.at(-1)?.payload).toMatchObject({ state: 'interrupted', error: 'file-no-space' })
  })

  it('Resume during the countdown drops the attempt waiting and plays the transfer on from its bytes', () => {
    const s = stage()
    start(s, spec({ error: 'network-timeout', retrying: 3 }))
    expect(interruptions(s.events)).toHaveLength(1)

    s.handlers['download.resume']({ id: 'd1' })
    const restarted = s.events.at(-1)
    expect(restarted?.name).toBe('download.started')
    expect(restarted?.payload).toMatchObject({ resumes: 'd1', canResume: true })
    s.handlers['download.bind']({ token: String(restarted?.payload['token']), id: 'd1' })

    // The scheduled attempt never fires as a second interruption; the bytes run on.
    vi.advanceTimersByTime(10_000)
    expect(interruptions(s.events)).toHaveLength(1)
    const done = s.events.find((e) => e.name === 'download.done')
    expect(done?.payload).toMatchObject({ state: 'completed', receivedBytes: 1000 })
  })
})
