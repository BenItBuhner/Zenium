import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', once: vi.fn() },
  dialog: { showOpenDialog: vi.fn() }
}))

import type { Debugger } from 'electron'
import {
  acceptExtensions,
  answerFileChooser,
  armFrameChoosers,
  ATTACH_FRAMES,
  INTERCEPT_FILE_CHOOSERS
} from '../agentPrompts'

type Sent = { method: string; params: unknown; sessionId?: string }

function fakeDebugger(fail: string | null = null): Debugger & { sent: Sent[] } {
  const sent: Sent[] = []
  return {
    sent,
    sendCommand: async (method: string, params: unknown, sessionId?: string) => {
      sent.push({ method, params, ...(sessionId ? { sessionId } : {}) })
      if (method === fail) throw new Error(`${method} failed`)
      if (method === 'DOM.describeNode') return { node: { attributes: ['accept', '.txt'] } }
      if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } }
      return {}
    }
  } as unknown as Debugger & { sent: Sent[] }
}

describe('armFrameChoosers', () => {
  it("intercepts a cross-site frame's choosers on its own session, attaches its frames, then runs it", async () => {
    const dbg = fakeDebugger()
    await armFrameChoosers(dbg, {
      sessionId: 'frame-1',
      targetInfo: { type: 'iframe' },
      waitingForDebugger: true
    })
    expect(dbg.sent.map((s) => s.method)).toEqual([
      ...INTERCEPT_FILE_CHOOSERS.map((c) => c.method),
      ATTACH_FRAMES.method,
      'Runtime.runIfWaitingForDebugger'
    ])
    expect(dbg.sent.every((s) => s.sessionId === 'frame-1')).toBe(true)
    expect(dbg.sent[1].params).toEqual({ enabled: true })
    expect(dbg.sent[2].params).toMatchObject({ autoAttach: true, waitForDebuggerOnStart: true })
  })

  it('lets the frame run even when arming fails, and only runs what is not a frame', async () => {
    const failing = fakeDebugger('Page.setInterceptFileChooserDialog')
    await expect(
      armFrameChoosers(failing, { sessionId: 'f', targetInfo: { type: 'iframe' } })
    ).rejects.toThrow()
    expect(failing.sent.at(-1)?.method).toBe('Runtime.runIfWaitingForDebugger')

    const worker = fakeDebugger()
    await armFrameChoosers(worker, {
      sessionId: 'w',
      targetInfo: { type: 'worker' },
      waitingForDebugger: true
    })
    expect(worker.sent.map((s) => s.method)).toEqual(['Runtime.runIfWaitingForDebugger'])

    const none = fakeDebugger()
    await armFrameChoosers(none, { targetInfo: { type: 'iframe' } })
    expect(none.sent).toEqual([])
  })
})

describe('answerFileChooser', () => {
  const hold =
    (dbg: Debugger) =>
    async <T>(fn: (d: Debugger) => Promise<T>) =>
      fn(dbg)

  it("answers a cross-site frame's chooser on that frame's session", async () => {
    const dbg = fakeDebugger()
    const ask = vi.fn(async () => ({ kind: 'files' as const, files: [{ path: '/tmp/a.txt' }] }))
    await answerFileChooser(
      hold(dbg),
      { backendNodeId: 9, mode: 'selectSingle' },
      ask,
      () => null,
      'frame-1'
    )
    expect(ask).toHaveBeenCalledWith({ mode: 'single', accept: ['.txt'], source: 'input' })
    expect(dbg.sent).toEqual([
      { method: 'DOM.describeNode', params: { backendNodeId: 9 }, sessionId: 'frame-1' },
      {
        method: 'DOM.setFileInputFiles',
        params: { files: ['/tmp/a.txt'], backendNodeId: 9 },
        sessionId: 'frame-1'
      }
    ])
  })

  it("cancels on the frame's session too", async () => {
    const dbg = fakeDebugger()
    await answerFileChooser(
      hold(dbg),
      { backendNodeId: 9 },
      async () => ({ kind: 'cancel' }),
      () => null,
      'frame-2'
    )
    expect(dbg.sent.map((s) => [s.method, s.sessionId])).toEqual([
      ['DOM.describeNode', 'frame-2'],
      ['DOM.resolveNode', 'frame-2'],
      ['Runtime.callFunctionOn', 'frame-2'],
      ['Runtime.releaseObject', 'frame-2']
    ])
  })
})

describe('acceptExtensions', () => {
  it('filters by extensions and by the MIME types it knows, else not at all', () => {
    expect(acceptExtensions(['.txt', '.CSV'])).toEqual(['txt', 'csv'])
    expect(acceptExtensions(['application/pdf', '.docx'])).toEqual(['pdf', 'docx'])
    expect(acceptExtensions(['image/*'])).toContain('png')
    expect(acceptExtensions(['image/png', 'image/jpeg'])).toEqual(['png', 'jpg', 'jpeg'])
    expect(acceptExtensions(['application/x-unknown', '.txt'])).toBeNull()
    expect(acceptExtensions(['.'])).toBeNull()
    expect(acceptExtensions([])).toBeNull()
  })
})
