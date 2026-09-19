import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VoiceStartOutcome } from '@shared/voice'

vi.mock('../api', () => ({ cmd: vi.fn(), run: vi.fn() }))
vi.mock('../ui', () => ({
  pushToast: vi.fn(),
  openVoiceSheet: vi.fn(),
  closeVoiceSheet: vi.fn()
}))

import type { VoicePrompt } from '../ui'
import {
  cancelVoiceSearch,
  currentVoicePrompt,
  retryVoiceSearch,
  setVoiceSearchIo,
  startVoiceSearch,
  voiceEvent,
  voiceStore,
  type VoiceSearchIo
} from '../voiceSearch'

interface Toast {
  message: string
  kind: 'info' | 'error'
  action?: { label: string; onPick: () => void }
}

/** The module's side effects, recorded; `outcome` is what the host answers `voice.start` with. */
function harness(outcome: VoiceStartOutcome | (() => VoiceStartOutcome) = 'listening'): {
  io: VoiceSearchIo
  starts: number
  cancels: number
  settings: number
  submits: Array<{ input: string; prompt: VoicePrompt }>
  toasts: Toast[]
  opened: VoicePrompt[]
  closed: number[]
} {
  const rec = {
    starts: 0,
    cancels: 0,
    settings: 0,
    submits: [] as Array<{ input: string; prompt: VoicePrompt }>,
    toasts: [] as Toast[],
    opened: [] as VoicePrompt[],
    closed: [] as number[]
  }
  const io: VoiceSearchIo = {
    start: async () => {
      rec.starts++
      return typeof outcome === 'function' ? outcome() : outcome
    },
    cancel: () => void rec.cancels++,
    openSettings: () => void rec.settings++,
    submit: (input, prompt) => void rec.submits.push({ input, prompt }),
    toast: (message, kind, action) => void rec.toasts.push({ message, kind, action }),
    openSheet: async (prompt) => void rec.opened.push(prompt),
    closeSheet: (id) => void rec.closed.push(id)
  }
  return Object.assign(rec, { io })
}

let restore: (() => void) | null = null

beforeEach(() => {
  voiceStore.set({ session: null })
})

afterEach(() => {
  // A live session from one test must not leak into the next: Cancel ends it through the module.
  cancelVoiceSearch()
  restore?.()
  restore = null
})

describe('startVoiceSearch', () => {
  it('puts the sheet up in its starting phase before the microphone is asked for', async () => {
    const h = harness()
    restore = setVoiceSearchIo(h.io)
    await startVoiceSearch({ tabId: 't1', newTab: false })
    expect(h.opened).toEqual([{ id: expect.any(Number), tabId: 't1', newTab: false }])
    expect(h.starts).toBe(1)
    expect(currentVoicePrompt()).toEqual(h.opened[0])
    expect(voiceStore.get().session?.phase).toBe('starting')
  })

  it('loads into a new tab when there is no tab to load in, unless told otherwise', async () => {
    const h = harness()
    restore = setVoiceSearchIo(h.io)
    await startVoiceSearch({ tabId: null })
    expect(h.opened[0]?.newTab).toBe(true)
    cancelVoiceSearch()
    await startVoiceSearch({ tabId: 't1' })
    expect(h.opened[1]?.newTab).toBe(false)
    cancelVoiceSearch()
    await startVoiceSearch({ tabId: 't1', newTab: true })
    expect(h.opened[2]?.newTab).toBe(true)
  })

  it('takes the sheet down with a toast when the microphone is refused this once', async () => {
    const h = harness('denied')
    restore = setVoiceSearchIo(h.io)
    await startVoiceSearch({ tabId: 't1' })
    expect(h.closed).toEqual([h.opened[0]!.id])
    expect(h.toasts).toHaveLength(1)
    expect(h.toasts[0]).toMatchObject({
      kind: 'info',
      message: expect.stringMatching(/microphone/i)
    })
    expect(h.toasts[0]!.action).toBeUndefined()
    expect(currentVoicePrompt()).toBeNull()
    expect(voiceStore.get().session).toBeNull()
  })

  it('offers Open settings on the toast after a permanent refusal, and the action opens them', async () => {
    const h = harness('denied-permanently')
    restore = setVoiceSearchIo(h.io)
    await startVoiceSearch({ tabId: 't1' })
    expect(h.closed).toHaveLength(1)
    const toast = h.toasts[0]!
    expect(toast.message).toMatch(/turned off/)
    expect(toast.action?.label).toBe('Open settings')
    toast.action!.onPick()
    expect(h.settings).toBe(1)
  })

  it('reports a recogniser that is not there as an error and takes the sheet down', async () => {
    const h = harness('unavailable')
    restore = setVoiceSearchIo(h.io)
    await startVoiceSearch({ tabId: 't1' })
    expect(h.toasts[0]).toMatchObject({
      kind: 'error',
      message: expect.stringMatching(/not available/)
    })
    expect(h.closed).toHaveLength(1)
  })

  it('treats a start that throws like a missing recogniser', async () => {
    const h = harness()
    h.io.start = async () => {
      throw new Error('bridge gone')
    }
    restore = setVoiceSearchIo(h.io)
    await startVoiceSearch({ tabId: 't1' })
    expect(h.toasts[0]?.kind).toBe('error')
    expect(h.closed).toHaveLength(1)
  })

  it('does nothing for a refusal that answers after the sheet was cancelled', async () => {
    let answer: ((outcome: VoiceStartOutcome) => void) | null = null
    const h = harness()
    h.io.start = () =>
      new Promise<VoiceStartOutcome>((resolve) => {
        answer = resolve
      })
    restore = setVoiceSearchIo(h.io)
    const started = startVoiceSearch({ tabId: 't1' })
    await Promise.resolve()
    cancelVoiceSearch()
    expect(h.closed).toHaveLength(1)
    answer!('denied')
    await started
    expect(h.toasts).toHaveLength(0)
    expect(h.closed).toHaveLength(1)
  })

  it('cancels a live session before starting another', async () => {
    const h = harness()
    restore = setVoiceSearchIo(h.io)
    await startVoiceSearch({ tabId: 't1' })
    await startVoiceSearch({ tabId: 't2' })
    expect(h.cancels).toBe(1)
    expect(h.opened).toHaveLength(2)
    expect(currentVoicePrompt()?.tabId).toBe('t2')
  })
})

describe('voiceEvent', () => {
  it('follows the recogniser through listening, a partial and the levels', async () => {
    const h = harness()
    restore = setVoiceSearchIo(h.io)
    await startVoiceSearch({ tabId: 't1' })
    voiceEvent({ kind: 'ready' })
    expect(voiceStore.get().session?.phase).toBe('listening')
    voiceEvent({ kind: 'rms', level: 0.6 })
    expect(voiceStore.get().session?.level).toBe(0.6)
    voiceEvent({ kind: 'partial', text: 'weather in' })
    expect(voiceStore.get().session).toMatchObject({ phase: 'heard', transcript: 'weather in' })
    expect(h.submits).toHaveLength(0)
    expect(h.closed).toHaveLength(0)
  })

  it('submits the final transcript where a typed submit would go and takes the sheet down', async () => {
    const h = harness()
    restore = setVoiceSearchIo(h.io)
    await startVoiceSearch({ tabId: 't1', newTab: false })
    voiceEvent({ kind: 'ready' })
    voiceEvent({ kind: 'end' })
    expect(voiceStore.get().session?.phase).toBe('finishing')
    voiceEvent({ kind: 'result', text: 'weather in london' })
    expect(h.submits).toEqual([
      { input: 'weather in london', prompt: { id: expect.any(Number), tabId: 't1', newTab: false } }
    ])
    expect(h.closed).toEqual([h.opened[0]!.id])
    expect(h.cancels).toBe(0)
    expect(currentVoicePrompt()).toBeNull()
  })

  it('submits an address the same way (the submit decides navigate or search)', async () => {
    const h = harness()
    restore = setVoiceSearchIo(h.io)
    await startVoiceSearch({ tabId: null })
    voiceEvent({ kind: 'result', text: 'example.com' })
    expect(h.submits[0]).toMatchObject({
      input: 'example.com',
      prompt: { tabId: null, newTab: true }
    })
  })

  it('keeps the sheet up as Didn\u2019t catch that after a no-match, and Try again listens once more', async () => {
    const h = harness()
    restore = setVoiceSearchIo(h.io)
    await startVoiceSearch({ tabId: 't1' })
    voiceEvent({ kind: 'ready' })
    voiceEvent({ kind: 'error', error: 'no-match' })
    expect(voiceStore.get().session?.phase).toBe('no-match')
    expect(h.closed).toHaveLength(0)
    expect(h.toasts).toHaveLength(0)
    retryVoiceSearch()
    await Promise.resolve()
    expect(h.starts).toBe(2)
    expect(h.opened).toHaveLength(1)
    expect(voiceStore.get().session?.phase).toBe('starting')
    voiceEvent({ kind: 'result', text: 'second try' })
    expect(h.submits[0]?.input).toBe('second try')
  })

  it('ignores Try again unless the sheet is in its no-match state', async () => {
    const h = harness()
    restore = setVoiceSearchIo(h.io)
    await startVoiceSearch({ tabId: 't1' })
    voiceEvent({ kind: 'ready' })
    retryVoiceSearch()
    expect(h.starts).toBe(1)
  })

  it('toasts an error the user cannot answer here and takes the sheet down', async () => {
    const h = harness()
    restore = setVoiceSearchIo(h.io)
    await startVoiceSearch({ tabId: 't1' })
    voiceEvent({ kind: 'ready' })
    voiceEvent({ kind: 'error', error: 'network' })
    expect(h.toasts).toEqual([
      { message: expect.stringMatching(/internet/), kind: 'error', action: undefined }
    ])
    expect(h.closed).toHaveLength(1)
    expect(h.submits).toHaveLength(0)
  })

  it('takes the sheet down without a word when the host aborts', async () => {
    const h = harness()
    restore = setVoiceSearchIo(h.io)
    await startVoiceSearch({ tabId: 't1' })
    voiceEvent({ kind: 'ready' })
    voiceEvent({ kind: 'aborted' })
    expect(h.toasts).toHaveLength(0)
    expect(h.closed).toHaveLength(1)
    expect(h.cancels).toBe(0)
  })

  it('drops events with no session up', () => {
    const h = harness()
    restore = setVoiceSearchIo(h.io)
    voiceEvent({ kind: 'result', text: 'nothing listens' })
    expect(h.submits).toHaveLength(0)
    expect(h.closed).toHaveLength(0)
  })
})

describe('cancelVoiceSearch', () => {
  it('stops the recogniser and takes the sheet down while it listens', async () => {
    const h = harness()
    restore = setVoiceSearchIo(h.io)
    await startVoiceSearch({ tabId: 't1' })
    voiceEvent({ kind: 'ready' })
    voiceEvent({ kind: 'partial', text: 'weath' })
    cancelVoiceSearch()
    expect(h.cancels).toBe(1)
    expect(h.closed).toEqual([h.opened[0]!.id])
    expect(h.submits).toHaveLength(0)
    expect(voiceStore.get().session).toBeNull()
    // Reports from a recogniser that has not heard yet go nowhere.
    voiceEvent({ kind: 'result', text: 'weather' })
    expect(h.submits).toHaveLength(0)
  })

  it('has nothing to stop after a no-match, and nothing to do with no sheet up', async () => {
    const h = harness()
    restore = setVoiceSearchIo(h.io)
    await startVoiceSearch({ tabId: 't1' })
    voiceEvent({ kind: 'error', error: 'no-match' })
    cancelVoiceSearch()
    expect(h.cancels).toBe(0)
    expect(h.closed).toHaveLength(1)
    cancelVoiceSearch()
    expect(h.closed).toHaveLength(1)
  })
})
