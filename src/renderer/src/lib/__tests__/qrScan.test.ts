import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QrStartOutcome } from '@shared/qrScan'
import type { Rect } from '@shared/types'

vi.mock('../api', () => ({ cmd: vi.fn(), run: vi.fn() }))
vi.mock('../ui', () => ({
  browserStore: { get: () => ({ state: null }) },
  pushToast: vi.fn(),
  openQrSheet: vi.fn(),
  closeQrSheet: vi.fn()
}))

import type { QrPrompt } from '../ui'
import {
  cancelQrScan,
  currentQrPrompt,
  layoutQrPreview,
  qrEvent,
  qrStore,
  releaseQrSession,
  setQrScanIo,
  startQrScan,
  toggleQrTorch,
  type QrScanIo
} from '../qrScan'

interface Toast {
  message: string
  kind: 'info' | 'error'
  action?: { label: string; onPick: () => void }
}

type Slot = { rect: Rect; radius: number; visible: boolean }

/** The module's side effects, recorded; `outcome` is what the host answers `qr.start` with. */
function harness(outcome: QrStartOutcome | (() => QrStartOutcome) = 'scanning'): {
  io: QrScanIo
  starts: number
  cancels: number
  settings: number
  haptics: number
  torch: boolean[]
  layouts: Slot[]
  submits: Array<{ input: string; prompt: QrPrompt }>
  searches: Array<{ query: string; prompt: QrPrompt }>
  toasts: Toast[]
  opened: QrPrompt[]
  closed: number[]
} {
  const rec = {
    starts: 0,
    cancels: 0,
    settings: 0,
    haptics: 0,
    torch: [] as boolean[],
    layouts: [] as Slot[],
    submits: [] as Array<{ input: string; prompt: QrPrompt }>,
    searches: [] as Array<{ query: string; prompt: QrPrompt }>,
    toasts: [] as Toast[],
    opened: [] as QrPrompt[],
    closed: [] as number[]
  }
  const io: QrScanIo = {
    start: async () => {
      rec.starts++
      return typeof outcome === 'function' ? outcome() : outcome
    },
    cancel: () => void rec.cancels++,
    layout: (slot) => void rec.layouts.push(slot),
    setTorch: (on) => void rec.torch.push(on),
    openSettings: () => void rec.settings++,
    submit: (input, prompt) => void rec.submits.push({ input, prompt }),
    search: (query, prompt) => void rec.searches.push({ query, prompt }),
    haptic: () => void rec.haptics++,
    toast: (message, kind, action) => void rec.toasts.push({ message, kind, action }),
    openSheet: async (prompt) => void rec.opened.push(prompt),
    closeSheet: (id) => void rec.closed.push(id)
  }
  return Object.assign(rec, { io })
}

let restore: (() => void) | null = null

beforeEach(() => {
  qrStore.set({ session: null })
})

afterEach(() => {
  // A live session from one test must not leak into the next: Cancel ends it through the module.
  cancelQrScan()
  restore?.()
  restore = null
})

/** A session up to the camera streaming (the `ready` report), torch as given. */
async function scanning(h: ReturnType<typeof harness>, torch = true): Promise<QrPrompt> {
  await startQrScan({ tabId: 't1', newTab: false })
  qrEvent({ kind: 'ready', torch })
  return h.opened.at(-1)!
}

describe('startQrScan', () => {
  it('puts the sheet up in its starting phase before the camera is asked for', async () => {
    const h = harness()
    restore = setQrScanIo(h.io)
    await startQrScan({ tabId: 't1', newTab: false })
    expect(h.opened).toEqual([{ id: expect.any(Number), tabId: 't1', newTab: false }])
    expect(h.starts).toBe(1)
    expect(currentQrPrompt()).toEqual(h.opened[0])
    expect(qrStore.get().session?.phase).toBe('starting')
    expect(h.closed).toEqual([])
  })

  it('loads into a new tab when there is no tab to load in, unless told otherwise', async () => {
    const h = harness()
    restore = setQrScanIo(h.io)
    await startQrScan({ tabId: null })
    expect(h.opened[0]?.newTab).toBe(true)
    cancelQrScan()
    await startQrScan({ tabId: 't1' })
    expect(h.opened[1]?.newTab).toBe(false)
    cancelQrScan()
    await startQrScan({ tabId: 't1', newTab: true })
    expect(h.opened[2]?.newTab).toBe(true)
  })

  it('takes the sheet down with a toast when the camera is refused this once', async () => {
    const h = harness('denied')
    restore = setQrScanIo(h.io)
    await startQrScan({ tabId: 't1' })
    expect(h.closed).toEqual([h.opened[0]!.id])
    expect(h.toasts).toHaveLength(1)
    expect(h.toasts[0]).toMatchObject({ kind: 'info', message: expect.stringMatching(/camera/i) })
    expect(h.toasts[0]!.action).toBeUndefined()
    expect(currentQrPrompt()).toBeNull()
  })

  it('offers Open settings on the toast after a permanent refusal, and the action opens them', async () => {
    const h = harness('denied-permanently')
    restore = setQrScanIo(h.io)
    await startQrScan({ tabId: 't1' })
    expect(h.closed).toHaveLength(1)
    const toast = h.toasts[0]!
    expect(toast.message).toMatch(/turned off/)
    expect(toast.action?.label).toBe('Open settings')
    toast.action!.onPick()
    expect(h.settings).toBe(1)
  })

  it('reports a camera that is not there as an error and takes the sheet down', async () => {
    const h = harness('unavailable')
    restore = setQrScanIo(h.io)
    await startQrScan({ tabId: 't1' })
    expect(h.toasts[0]).toMatchObject({
      kind: 'error',
      message: expect.stringMatching(/not available/)
    })
    expect(h.closed).toHaveLength(1)
  })

  it('treats a start that throws like a missing camera', async () => {
    const h = harness()
    h.io.start = async () => {
      throw new Error('bridge gone')
    }
    restore = setQrScanIo(h.io)
    await startQrScan({ tabId: 't1' })
    expect(h.toasts[0]?.kind).toBe('error')
    expect(h.closed).toHaveLength(1)
  })

  it('does nothing further when the scan was cancelled while the camera was being asked for', async () => {
    let answer: ((outcome: QrStartOutcome) => void) | null = null
    const h = harness()
    h.io.start = () => new Promise<QrStartOutcome>((resolve) => (answer = resolve))
    restore = setQrScanIo(h.io)
    const started = startQrScan({ tabId: 't1' })
    // The sheet goes up first; the camera is asked for on the next turn.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(answer).not.toBeNull()
    cancelQrScan()
    expect(h.cancels).toBe(1)
    expect(h.closed).toHaveLength(1)
    answer!('denied')
    await started
    // No second close, no toast for a refusal nobody is waiting on.
    expect(h.closed).toHaveLength(1)
    expect(h.toasts).toEqual([])
  })

  it('a second tap while a session is live cancels the first and opens a new sheet', async () => {
    const h = harness()
    restore = setQrScanIo(h.io)
    await startQrScan({ tabId: 't1' })
    const first = h.opened[0]!
    await startQrScan({ tabId: 't2' })
    expect(h.cancels).toBe(1)
    expect(h.opened).toHaveLength(2)
    expect(h.opened[1]!.id).not.toBe(first.id)
    expect(currentQrPrompt()?.tabId).toBe('t2')
  })
})

describe('qrEvent: the camera reporting', () => {
  it('moves the session to scanning with the torch the camera has', async () => {
    const h = harness()
    restore = setQrScanIo(h.io)
    await scanning(h, true)
    expect(qrStore.get().session).toMatchObject({ phase: 'scanning', torch: true, torchOn: false })
    expect(h.closed).toEqual([])
  })

  it('keeps the last still for the slot', async () => {
    const h = harness()
    restore = setQrScanIo(h.io)
    await scanning(h)
    qrEvent({ kind: 'still', dataUrl: 'data:image/jpeg;base64,AAAA' })
    expect(qrStore.get().session?.still).toBe('data:image/jpeg;base64,AAAA')
    qrEvent({ kind: 'still', dataUrl: '' })
    expect(qrStore.get().session?.still).toBe('data:image/jpeg;base64,AAAA')
  })

  it('submits a decoded address as scanned, with a haptic, and takes the sheet down', async () => {
    const h = harness()
    restore = setQrScanIo(h.io)
    const prompt = await scanning(h)
    qrEvent({ kind: 'decoded', text: ' https://example.org/ \n' })
    expect(h.haptics).toBe(1)
    expect(h.submits).toEqual([{ input: 'https://example.org/', prompt }])
    // The camera is released at once, not at the end of the sheet's leave.
    expect(h.cancels).toBe(1)
    expect(h.closed).toEqual([prompt.id])
    expect(currentQrPrompt()).toBeNull()
    // The terminal session stays for the leaving sheet to draw.
    expect(qrStore.get().session).toMatchObject({ phase: 'done', text: 'https://example.org/' })
  })

  it('submits decoded words as a search through the typed path', async () => {
    const h = harness()
    restore = setQrScanIo(h.io)
    const prompt = await scanning(h)
    qrEvent({ kind: 'decoded', text: 'table 12\norder 4471' })
    expect(h.submits).toEqual([{ input: 'table 12 order 4471', prompt }])
    expect(h.haptics).toBe(1)
  })

  it('searches a Wi-Fi payload by its network name outright, never its password', async () => {
    const h = harness()
    restore = setQrScanIo(h.io)
    const prompt = await scanning(h)
    // A network named like a host is still a name: the search, not the typed path that would
    // read it as an address.
    qrEvent({ kind: 'decoded', text: 'WIFI:T:WPA;S:cafe.net;P:hunter2;;' })
    expect(h.searches).toEqual([{ query: 'cafe.net', prompt }])
    expect(h.submits).toEqual([])
    expect(JSON.stringify(h.searches)).not.toContain('hunter2')
    expect(h.haptics).toBe(1)
  })

  it('searches a contact by its name outright', async () => {
    const h = harness()
    restore = setQrScanIo(h.io)
    const prompt = await scanning(h)
    qrEvent({ kind: 'decoded', text: 'BEGIN:VCARD\nVERSION:3.0\nFN:bit.ly\nEND:VCARD' })
    expect(h.searches).toEqual([{ query: 'bit.ly', prompt }])
    expect(h.submits).toEqual([])
  })

  it('refuses a code naming a Zenium page: a toast, the sheet down, nothing loaded', async () => {
    const h = harness()
    restore = setQrScanIo(h.io)
    const prompt = await scanning(h)
    qrEvent({ kind: 'decoded', text: 'zenium://settings' })
    expect(h.submits).toEqual([])
    expect(h.searches).toEqual([])
    expect(h.haptics).toBe(0)
    expect(h.toasts).toEqual([
      { message: 'This code points to a Zenium page', kind: 'info', action: undefined }
    ])
    expect(h.cancels).toBe(1)
    expect(h.closed).toEqual([prompt.id])
    expect(currentQrPrompt()).toBeNull()
  })

  it('drops a decode the camera reports after Cancel: nothing loads', async () => {
    const h = harness()
    restore = setQrScanIo(h.io)
    const prompt = await scanning(h)
    // Cancel (the button, Escape, the back gesture's commit) ends the session at once; the
    // camera's last frame may still come in as the sheet falls.
    cancelQrScan()
    expect(h.cancels).toBe(1)
    expect(h.closed).toEqual([prompt.id])
    qrEvent({ kind: 'decoded', text: 'https://example.org/' })
    qrEvent({ kind: 'decoded', text: 'weather in Lisbon' })
    expect(h.submits).toEqual([])
    expect(h.searches).toEqual([])
    expect(h.haptics).toBe(0)
    expect(h.toasts).toEqual([])
    // The session the leaving sheet draws is cancelled, its window no longer live.
    expect(qrStore.get().session).toMatchObject({ phase: 'cancelled', torchOn: false })
  })

  it('a decode with no text is nothing found: the session keeps scanning', async () => {
    const h = harness()
    restore = setQrScanIo(h.io)
    await scanning(h)
    qrEvent({ kind: 'decoded', text: '   ' })
    expect(qrStore.get().session?.phase).toBe('scanning')
    expect(h.submits).toEqual([])
    expect(h.haptics).toBe(0)
    expect(h.closed).toEqual([])
  })

  it('toasts an error and takes the sheet down, releasing nothing twice', async () => {
    const h = harness()
    restore = setQrScanIo(h.io)
    const prompt = await scanning(h)
    qrEvent({ kind: 'error', error: 'busy' })
    expect(h.toasts).toEqual([
      { message: expect.stringMatching(/another app/), kind: 'error', action: undefined }
    ])
    expect(h.closed).toEqual([prompt.id])
    // The host has already stopped its camera on an error; nothing to cancel.
    expect(h.cancels).toBe(0)
    expect(h.submits).toEqual([])
  })

  it('an abort (the app went behind) just closes the sheet', async () => {
    const h = harness()
    restore = setQrScanIo(h.io)
    const prompt = await scanning(h)
    qrEvent({ kind: 'aborted' })
    expect(h.closed).toEqual([prompt.id])
    expect(h.toasts).toEqual([])
    expect(h.submits).toEqual([])
  })

  it('ignores reports once the session is over, and with no session at all', async () => {
    const h = harness()
    restore = setQrScanIo(h.io)
    await scanning(h)
    qrEvent({ kind: 'decoded', text: 'first' })
    qrEvent({ kind: 'decoded', text: 'second' })
    qrEvent({ kind: 'error', error: 'camera' })
    expect(h.submits).toHaveLength(1)
    expect(h.toasts).toEqual([])
    expect(h.closed).toHaveLength(1)
    qrStore.set({ session: null })
    expect(() => qrEvent({ kind: 'ready', torch: false })).not.toThrow()
  })
})

describe('the torch', () => {
  it('asks the host for the other state while scanning with a torch, and follows its answer', async () => {
    const h = harness()
    restore = setQrScanIo(h.io)
    await scanning(h, true)
    toggleQrTorch()
    expect(h.torch).toEqual([true])
    // Nothing changes until the host says so.
    expect(qrStore.get().session?.torchOn).toBe(false)
    qrEvent({ kind: 'torch', on: true })
    expect(qrStore.get().session?.torchOn).toBe(true)
    toggleQrTorch()
    expect(h.torch).toEqual([true, false])
  })

  it('is not asked for on a camera without one, nor before the camera streams', async () => {
    const h = harness()
    restore = setQrScanIo(h.io)
    await startQrScan({ tabId: 't1' })
    toggleQrTorch()
    qrEvent({ kind: 'ready', torch: false })
    toggleQrTorch()
    expect(h.torch).toEqual([])
  })

  it('is off again on the session that decoded', async () => {
    const h = harness()
    restore = setQrScanIo(h.io)
    await scanning(h, true)
    qrEvent({ kind: 'torch', on: true })
    qrEvent({ kind: 'decoded', text: 'https://example.org/' })
    expect(qrStore.get().session?.torchOn).toBe(false)
  })
})

describe('cancel and the preview slot', () => {
  it('Cancel releases the camera and takes the sheet down, once', async () => {
    const h = harness()
    restore = setQrScanIo(h.io)
    const prompt = await scanning(h)
    cancelQrScan()
    cancelQrScan()
    expect(h.cancels).toBe(1)
    expect(h.closed).toEqual([prompt.id])
    expect(currentQrPrompt()).toBeNull()
  })

  it('lays the preview where the sheet says while a session is live, and not after', async () => {
    const h = harness()
    restore = setQrScanIo(h.io)
    await scanning(h)
    const slot = { rect: { x: 46, y: 300, width: 320, height: 320 }, radius: 8, visible: true }
    layoutQrPreview(slot)
    expect(h.layouts).toEqual([slot])
    cancelQrScan()
    layoutQrPreview({ ...slot, visible: false })
    expect(h.layouts).toHaveLength(1)
  })
})

describe('the session after the sheet', () => {
  it('keeps the terminal session, still and all, for the leave and lets it go once the sheet has left', async () => {
    const h = harness()
    restore = setQrScanIo(h.io)
    const prompt = await scanning(h)
    qrEvent({ kind: 'still', dataUrl: 'data:image/jpeg;base64,AAAA' })
    cancelQrScan()
    expect(qrStore.get().session?.still).toBe('data:image/jpeg;base64,AAAA')
    releaseQrSession(prompt.id)
    expect(qrStore.get().session).toBeNull()
  })

  it('does not let a live session go, nor a newer one, for a sheet that has left', async () => {
    const h = harness()
    restore = setQrScanIo(h.io)
    const first = await scanning(h)
    // React's development double-mount unmounts and mounts the live sheet once: nothing goes.
    releaseQrSession(first.id)
    expect(qrStore.get().session?.phase).toBe('scanning')
    // A second start while the first sheet is still leaving: the first sheet's release, when it
    // lands, must not take the second's session with it.
    cancelQrScan()
    await startQrScan({ tabId: 't2' })
    releaseQrSession(first.id)
    expect(qrStore.get().session?.phase).toBe('starting')
  })
})
