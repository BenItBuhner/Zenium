import { describe, expect, it, vi } from 'vitest'
import type { RequestContext } from '../../../core/blocking/rules'
import type { PermissionRequestDetails } from '../../../core/permissions'
import type { ContentGuardId } from '../../../shared/contentGuards'
import type { HostRequest, WebRequestBase } from '../webRequest'

vi.mock('electron', () => ({
  ipcMain: { on: () => undefined }
}))

const { ContentRulesHandler, attachContentGuards, guardsForSender, isPdfResponse, requestDetails } =
  await import('../contentRules')
const { documentStart } = await import('../documentStart')
const { HANDLER_ORDER } = await import('../webRequest')

function request(
  ctx: Partial<RequestContext> & { url: string },
  containerId = 'default'
): HostRequest {
  const full: RequestContext = { type: 'main_frame', method: 'GET', ...ctx }
  const base: WebRequestBase = {
    requestId: '1',
    url: full.url,
    method: full.method,
    resourceType: full.type,
    frameId: full.type === 'main_frame' ? 0 : 7,
    parentFrameId: full.type === 'main_frame' ? -1 : 0,
    tabId: 'tab-1',
    partition: containerId,
    initiator: full.initiator ?? null,
    documentUrl: full.documentUrl ?? null,
    timestamp: 0
  }
  return { ctx: full, containerId, tabId: 'tab-1', base, state: new Map() }
}

/** The core's answers: the sites listed are refused the row (per container where named). */
function lookup(denied: Record<string, string[]>): {
  allows: (id: string, url: string, details?: PermissionRequestDetails) => boolean
  blockedGuards: (url: string, details?: PermissionRequestDetails) => ContentGuardId[]
  asked: Array<[string, string, PermissionRequestDetails | undefined]>
} {
  const asked: Array<[string, string, PermissionRequestDetails | undefined]> = []
  // As the store answers: the stored decisions, plus the private container's own for its pages.
  const refused = (id: string, url: string, details?: PermissionRequestDetails): boolean => {
    const keys = details?.privateContainerId ? [id, `${id}@private`] : [id]
    return keys.some((key) => (denied[key] ?? []).some((site) => new URL(url).origin === site))
  }
  return {
    asked,
    allows: (id, url, details) => {
      asked.push([id, url, details])
      return !refused(id, url, details)
    },
    blockedGuards: (url, details) =>
      (['sensors', 'third-party-sign-in', 'payment-handler'] as ContentGuardId[]).filter((id) =>
        refused(id, url, details)
      )
  }
}

describe('ContentRulesHandler: images', () => {
  it('sits after the lookalike hold and ahead of the rule engine', () => {
    const handler = new ContentRulesHandler(lookup({}))
    expect(handler.order).toBe(HANDLER_ORDER.contentRules)
    expect(handler.order).toBeGreaterThan(HANDLER_ORDER.lookalike)
    expect(handler.order).toBeLessThan(HANDLER_ORDER.ruleEngine)
  })

  it("cancels a blocked page's image requests, by the document's site", () => {
    const rules = lookup({ images: ['https://blocked.example'] })
    const handler = new ContentRulesHandler(rules)
    expect(
      handler.onBeforeRequest(
        request({
          type: 'image',
          url: 'https://cdn.example/pic.png',
          documentUrl: 'https://blocked.example/page',
          initiator: 'https://blocked.example'
        })
      )
    ).toEqual({ cancel: true })
    expect(rules.asked[0]).toEqual(['images', 'https://blocked.example/page', undefined])
  })

  it('leaves other pages, other resource types and pages without a site alone', () => {
    const rules = lookup({ images: ['https://blocked.example'] })
    const handler = new ContentRulesHandler(rules)
    expect(
      handler.onBeforeRequest(
        request({
          type: 'image',
          url: 'https://cdn.example/pic.png',
          documentUrl: 'https://fine.example/page'
        })
      )
    ).toBeUndefined()
    expect(
      handler.onBeforeRequest(
        request({
          type: 'script',
          url: 'https://blocked.example/app.js',
          documentUrl: 'https://blocked.example/page'
        })
      )
    ).toBeUndefined()
    expect(
      handler.onBeforeRequest(
        request({ type: 'image', url: 'https://cdn.example/pic.png', documentUrl: 'zen://newtab' })
      )
    ).toBeUndefined()
    expect(
      handler.onBeforeRequest(request({ type: 'image', url: 'https://cdn.example/pic.png' }))
    ).toBeUndefined()
  })

  it("asks with the private container's details for a private window's page", () => {
    const rules = lookup({ 'images@private': ['https://blocked.example'] })
    const handler = new ContentRulesHandler(rules)
    const image = {
      type: 'image' as const,
      url: 'https://cdn.example/pic.png',
      documentUrl: 'https://blocked.example/page'
    }
    expect(handler.onBeforeRequest(request(image, 'private'))).toEqual({ cancel: true })
    expect(handler.onBeforeRequest(request(image, 'default'))).toBeUndefined()
    expect(requestDetails('private')).toEqual({ privateContainerId: 'private' })
    expect(requestDetails('default')).toBeUndefined()
  })
})

describe('ContentRulesHandler: PDF documents', () => {
  it('turns a "download" site\'s PDF document into an attachment', () => {
    const handler = new ContentRulesHandler(lookup({ pdf: ['https://docs.example'] }))
    const headers = { 'Content-Type': ['application/pdf'] }
    handler.onHeadersReceived(request({ url: 'https://docs.example/a.pdf' }), headers)
    expect(headers).toEqual({
      'Content-Type': ['application/pdf'],
      'Content-Disposition': ['attachment']
    })
  })

  it('replaces an inline disposition and covers frames', () => {
    const handler = new ContentRulesHandler(lookup({ pdf: ['https://docs.example'] }))
    const headers = {
      'content-type': ['application/pdf; charset=binary'],
      'content-disposition': ['inline; filename="a.pdf"']
    }
    handler.onHeadersReceived(
      request({ type: 'sub_frame', url: 'https://docs.example/frame.pdf' }),
      headers
    )
    expect(
      Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-disposition')?.[1]
    ).toEqual(['attachment'])
  })

  it('leaves other sites, other types and other documents as they are', () => {
    const handler = new ContentRulesHandler(lookup({ pdf: ['https://docs.example'] }))
    const other = { 'Content-Type': ['application/pdf'] }
    handler.onHeadersReceived(request({ url: 'https://fine.example/a.pdf' }), other)
    expect(other).toEqual({ 'Content-Type': ['application/pdf'] })
    const html = { 'Content-Type': ['text/html'] }
    handler.onHeadersReceived(request({ url: 'https://docs.example/' }), html)
    expect(html).toEqual({ 'Content-Type': ['text/html'] })
    const fetched = { 'Content-Type': ['application/pdf'] }
    handler.onHeadersReceived(
      request({
        type: 'xmlhttprequest',
        url: 'https://docs.example/a.pdf',
        documentUrl: 'https://docs.example/'
      }),
      fetched
    )
    expect(fetched).toEqual({ 'Content-Type': ['application/pdf'] })
  })

  it('knows a PDF response by its content type alone', () => {
    expect(isPdfResponse({ 'Content-Type': ['application/pdf'] })).toBe(true)
    expect(isPdfResponse({ 'content-type': [' Application/PDF;charset=x'] })).toBe(true)
    expect(isPdfResponse({ 'Content-Type': ['application/pdfx'] })).toBe(false)
    expect(isPdfResponse({ 'Content-Type': ['text/html'] })).toBe(false)
    expect(isPdfResponse({})).toBe(false)
  })
})

describe('guardsForSender', () => {
  const sender = (url: string, destroyed = false, session: object = {}): { sender: unknown } => ({
    sender: { isDestroyed: () => destroyed, getURL: () => url, session }
  })

  it("answers from the sender's top document, in the session's container", () => {
    const rules = lookup({
      sensors: ['https://still.example'],
      'payment-handler@private': ['https://still.example']
    })
    const privateSession = {}
    const containerOf = (ses: object): string | undefined =>
      ses === privateSession ? 'private' : 'default'
    const asEvent = (e: { sender: unknown }): Parameters<typeof guardsForSender>[1] =>
      e as Parameters<typeof guardsForSender>[1]
    expect(guardsForSender(rules, asEvent(sender('https://still.example/a')), containerOf)).toEqual(
      ['sensors']
    )
    expect(
      guardsForSender(
        rules,
        asEvent(sender('https://still.example/a', false, privateSession)),
        containerOf
      )
    ).toEqual(['sensors', 'payment-handler'])
    expect(guardsForSender(rules, asEvent(sender('https://fine.example/')), containerOf)).toEqual(
      []
    )
  })

  it('refuses nothing to the chrome, to a destroyed sender or to a page without a site', () => {
    const rules = lookup({ sensors: ['https://still.example'] })
    const containerOf = (): string => 'default'
    const asEvent = (e: { sender: unknown }): Parameters<typeof guardsForSender>[1] =>
      e as Parameters<typeof guardsForSender>[1]
    expect(guardsForSender(rules, asEvent(sender('zen://settings')), containerOf)).toEqual([])
    expect(
      guardsForSender(rules, asEvent(sender('https://still.example/', true)), containerOf)
    ).toEqual([])
    expect(guardsForSender(rules, asEvent({ sender: undefined }), containerOf)).toEqual([])
  })

  it("is the `guards` field of the page preload's document-start answer once attached", () => {
    const rules = lookup({ sensors: ['https://still.example'] })
    attachContentGuards(rules, () => 'default')
    const ask = (e: { sender: unknown }): unknown =>
      documentStart.answer(
        { ...e, senderFrame: null } as unknown as Parameters<typeof documentStart.answer>[0],
        { url: 'https://still.example/a' }
      ).guards
    expect(ask(sender('https://still.example/a'))).toEqual(['sensors'])
    expect(ask(sender('https://fine.example/'))).toEqual([])
    // The other fields stay at their defaults here: nobody else registered in this test.
    expect(
      documentStart.answer(
        { ...sender('https://still.example/'), senderFrame: null } as unknown as Parameters<
          typeof documentStart.answer
        >[0],
        { url: '' }
      )
    ).toEqual({
      signals: { gpc: false, dnt: false },
      displayMode: 'browser',
      guards: ['sensors'],
      userScripts: []
    })
  })
})
