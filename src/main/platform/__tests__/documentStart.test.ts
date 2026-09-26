import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ContentGuardId } from '../../../shared/contentGuards'
import type { DisplayMode } from '../../../shared/displayMode'
import type { DocumentStartAnswer, DocumentStartField } from '../../../shared/documentStart'
import type { DocumentStartEvent } from '../documentStart'

const ipcOn = vi.fn()
vi.mock('electron', () => ({ ipcMain: { on: (...args: unknown[]) => ipcOn(...args) } }))

const { DocumentStartRegistry, attachDocumentStart, documentStart, registerDocumentStartProvider } =
  await import('../documentStart')
const { documentStartDefaults } = await import('../../../shared/documentStart')

const FIELDS: DocumentStartField[] = ['signals', 'displayMode', 'guards', 'userScripts']

/** A full answer, one distinct value per field, so a default is told from a carried value. */
const ANSWERED: DocumentStartAnswer = {
  signals: { gpc: true, dnt: true },
  displayMode: 'standalone',
  guards: ['sensors'],
  userScripts: [{ extensionId: 'abc', incognito: false, worlds: [] }]
}

const EVENT = { sender: { id: 7 }, senderFrame: { url: 'https://page.example/' } }
const event = (): DocumentStartEvent => EVENT as unknown as DocumentStartEvent
const REQUEST = { url: 'https://page.example/' }

/** A registry with every provider answering, each a spy; `failing` throws instead. */
function registry(failing: DocumentStartField[] = []): {
  registry: InstanceType<typeof DocumentStartRegistry>
  calls: Record<DocumentStartField, ReturnType<typeof vi.fn>>
} {
  const r = new DocumentStartRegistry()
  const calls = {} as Record<DocumentStartField, ReturnType<typeof vi.fn>>
  for (const name of FIELDS) {
    const spy = vi.fn(() => {
      if (failing.includes(name)) throw new Error(`${name} broke`)
      return ANSWERED[name]
    })
    calls[name] = spy
    r.register(name, spy as never)
  }
  return { registry: r, calls }
}

afterEach(() => {
  vi.restoreAllMocks()
  ipcOn.mockReset()
})

describe('the composed document-start handler', () => {
  it('asks every provider exactly once per ask, in field order, with the sender and the request', () => {
    const { registry: r, calls } = registry()
    const order: string[] = []
    for (const name of FIELDS)
      calls[name].mockImplementation(() => (order.push(name), ANSWERED[name]))

    expect(r.answer(event(), REQUEST)).toEqual(ANSWERED)
    expect(order).toEqual(FIELDS)
    for (const name of FIELDS) {
      expect(calls[name]).toHaveBeenCalledTimes(1)
      expect(calls[name]).toHaveBeenCalledWith(EVENT, REQUEST)
    }
    // Never cached: the next document asks again and every provider runs again.
    r.answer(event(), { url: 'about:blank' })
    for (const name of FIELDS) expect(calls[name]).toHaveBeenCalledTimes(2)
    expect(calls.userScripts).toHaveBeenLastCalledWith(EVENT, { url: 'about:blank' })
  })

  it('answers the default for a field nobody provides and carries the rest', () => {
    const r = new DocumentStartRegistry()
    expect(r.answer(event(), REQUEST)).toEqual(documentStartDefaults())
    r.register('displayMode', (): DisplayMode => 'fullscreen')
    expect(r.answer(event(), REQUEST)).toEqual({
      ...documentStartDefaults(),
      displayMode: 'fullscreen'
    })
  })

  it.each(FIELDS)(
    'a provider that throws (%s) leaves its field at the default with the other three intact',
    (failing) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const { registry: r, calls } = registry([failing])
      const answer = r.answer(event(), REQUEST)
      expect(answer).toEqual({ ...ANSWERED, [failing]: documentStartDefaults()[failing] })
      // The failure skipped nothing: every provider, the failing one included, ran once.
      for (const name of FIELDS) expect(calls[name]).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledOnce()
      expect(warn.mock.calls[0]?.[0]).toBe(`[zen] document-start ${failing} failed:`)
    }
  )

  it("still asks the user-script plan when `guards` throws: the plan is the document's registration", () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { registry: r, calls } = registry(['guards'])
    const answer = r.answer(event(), REQUEST)
    expect(calls.userScripts).toHaveBeenCalledTimes(1)
    expect(calls.userScripts).toHaveBeenCalledWith(EVENT, REQUEST)
    expect(answer.userScripts).toEqual(ANSWERED.userScripts)
    expect(answer.guards).toEqual([])
    expect(answer.signals).toEqual(ANSWERED.signals)
    expect(answer.displayMode).toBe('standalone')
  })

  it('answers the defaults, every provider still asked once, when all four throw', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { registry: r, calls } = registry(FIELDS)
    expect(r.answer(event(), REQUEST)).toEqual(documentStartDefaults())
    for (const name of FIELDS) expect(calls[name]).toHaveBeenCalledTimes(1)
  })

  it('lets a later registration of a field replace the earlier one', () => {
    const r = new DocumentStartRegistry()
    r.register('displayMode', (): DisplayMode => 'standalone')
    r.register('displayMode', (): DisplayMode => 'fullscreen')
    expect(r.answer(event(), REQUEST).displayMode).toBe('fullscreen')
  })

  it('sets `returnValue` on the one channel, the request read from the preload or emptied', () => {
    const { registry: r, calls } = registry()
    const on = vi.fn()
    r.attach({ on })
    expect(on).toHaveBeenCalledOnce()
    expect(on.mock.calls[0]?.[0]).toBe('zen:document-start')
    const listener = on.mock.calls[0]?.[1] as (event: unknown, raw: unknown) => void

    const asked = { ...EVENT, returnValue: undefined as unknown }
    listener(asked, { url: 'https://page.example/a' })
    expect(asked.returnValue).toEqual(ANSWERED)
    expect(calls.userScripts).toHaveBeenCalledWith(asked, { url: 'https://page.example/a' })

    // Anything but the preload's `{ url }` reads as an empty URL; the answer still comes.
    for (const raw of [undefined, null, 'x', { url: 5 }]) {
      const again = { ...EVENT, returnValue: undefined as unknown }
      listener(again, raw)
      expect(again.returnValue).toEqual(ANSWERED)
      expect(calls.signals).toHaveBeenLastCalledWith(again, { url: '' })
    }
  })

  it("the app's registry: the owners' registrations answer through `ipcMain`'s one handler", () => {
    registerDocumentStartProvider('displayMode', (): DisplayMode => 'standalone')
    registerDocumentStartProvider('guards', (): ContentGuardId[] => ['payment-handler'])
    attachDocumentStart()
    expect(ipcOn).toHaveBeenCalledOnce()
    expect(ipcOn.mock.calls[0]?.[0]).toBe('zen:document-start')
    const listener = ipcOn.mock.calls[0]?.[1] as (event: unknown, raw: unknown) => void
    const asked = { ...EVENT, returnValue: undefined as unknown }
    listener(asked, REQUEST)
    expect(asked.returnValue).toEqual({
      ...documentStartDefaults(),
      displayMode: 'standalone',
      guards: ['payment-handler']
    })
    expect(documentStart.answer(event(), REQUEST).displayMode).toBe('standalone')
  })
})
