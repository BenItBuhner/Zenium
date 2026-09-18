import { describe, expect, it } from 'vitest'
import { AndroidWebNavigation, navigationReport } from '../extensionWebNavigation'
import {
  type Harness,
  backgroundUp,
  call,
  events,
  harness,
  makeTab,
  manifest,
  message,
  record
} from './runtimeHarness'

const TAB = { chromeTabId: 7, committedUrl: 'https://example.com/' }

function names(list: Array<{ event: string }>): string[] {
  return list.map((e) => e.event)
}

describe('AndroidWebNavigation: the navigation listener path', () => {
  it('reports one onBeforeNavigate per navigation and a committed document with its transition', () => {
    const nav = new AndroidWebNavigation(() => 1000)
    const started = nav.report('t1', TAB, {
      phase: 'started',
      url: 'https://a.test/',
      byPage: true
    })
    expect(names(started)).toEqual(['onBeforeNavigate'])
    expect(started[0].details).toMatchObject({
      tabId: 7,
      frameId: 0,
      parentFrameId: -1,
      url: 'https://a.test/',
      frameType: 'outermost_frame',
      documentLifecycle: 'active',
      timeStamp: 1000
    })
    // A server redirect along the way is remembered as a qualifier; no second onBeforeNavigate.
    expect(nav.report('t1', TAB, { phase: 'redirected', url: 'https://www.a.test/' })).toEqual([])
    const done = nav.report('t1', TAB, {
      phase: 'completed',
      url: 'https://www.a.test/',
      committed: true,
      byPage: true,
      statusCode: 200
    })
    expect(names(done)).toEqual(['onCommitted'])
    expect(done[0].details).toMatchObject({
      url: 'https://www.a.test/',
      transitionType: 'link',
      transitionQualifiers: ['server_redirect']
    })
    const doc = done[0].details.documentId
    expect(doc).not.toBe('')
    expect(names(nav.report('t1', TAB, { phase: 'dom', url: 'https://www.a.test/' }))).toEqual([
      'onDOMContentLoaded'
    ])
    const load = nav.report('t1', TAB, { phase: 'load', url: 'https://www.a.test/' })
    expect(names(load)).toEqual(['onCompleted'])
    expect(load[0].details.documentId).toBe(doc)
  })

  it('names reloads, history moves and the chrome’s own loads as Chrome does', () => {
    const nav = new AndroidWebNavigation(() => 0)
    nav.report('t1', TAB, { phase: 'started', url: 'https://a.test/', reload: true })
    const reload = nav.report('t1', TAB, {
      phase: 'completed',
      url: 'https://a.test/',
      committed: true,
      reload: true
    })
    expect(reload[0].details).toMatchObject({ transitionType: 'reload', transitionQualifiers: [] })

    nav.report('t1', TAB, { phase: 'started', url: 'https://b.test/', history: true })
    const back = nav.report('t1', TAB, {
      phase: 'completed',
      url: 'https://b.test/',
      committed: true,
      history: true
    })
    expect(back[0].details).toMatchObject({
      transitionType: 'link',
      transitionQualifiers: ['forward_back']
    })

    nav.report('t1', TAB, { phase: 'started', url: 'https://typed.test/' })
    const typed = nav.report('t1', TAB, {
      phase: 'completed',
      url: 'https://typed.test/',
      committed: true
    })
    expect(typed[0].details).toMatchObject({
      transitionType: 'typed',
      transitionQualifiers: ['from_address_bar']
    })
  })

  it('reports a failed navigation as onErrorOccurred only, hiding the error pages', () => {
    const nav = new AndroidWebNavigation(() => 0)
    nav.report('t1', TAB, { phase: 'started', url: 'https://down.test/' })
    const failed = nav.report('t1', TAB, {
      phase: 'completed',
      url: 'https://down.test/',
      committed: true,
      errorPage: true,
      error: 'net::ERR_NAME_NOT_RESOLVED'
    })
    expect(names(failed)).toEqual(['onErrorOccurred'])
    expect(failed[0].details).toMatchObject({
      url: 'https://down.test/',
      error: 'net::ERR_NAME_NOT_RESOLVED'
    })
    // WebView's own error page finishes under the failed URL: Chrome ended the navigation at the
    // error, so its DOMContentLoaded and load say nothing.
    expect(nav.report('t1', TAB, { phase: 'dom', url: 'https://down.test/' })).toEqual([])
    expect(nav.report('t1', TAB, { phase: 'load', url: 'https://down.test/' })).toEqual([])
    // The core's error page is the chrome's navigation: nothing of it reaches extensions. As
    // measured on WebView 156, the listener sees `loadDataWithBaseURL` start as a `data:`
    // navigation and complete under the `zen://error` base URL.
    expect(
      nav.report('t1', TAB, { phase: 'started', url: 'data:text/html;charset=utf-8;base64,' })
    ).toEqual([])
    expect(
      nav.report('t1', TAB, { phase: 'completed', url: 'zen://error?x', committed: true })
    ).toEqual([])
    expect(
      nav.report('t1', TAB, { phase: 'started', url: 'zen://error?url=https%3A%2F%2Fdown.test%2F' })
    ).toEqual([])
    expect(
      nav.report('t1', TAB, { phase: 'completed', url: 'zen://error?x', committed: true })
    ).toEqual([])
    expect(
      nav.report('t1', TAB, { phase: 'load', url: 'data:text/html;charset=utf-8;base64,' })
    ).toEqual([])
    expect(
      nav.report('t1', TAB, {
        phase: 'started',
        url: 'data:text/html;charset=utf-8;base64,',
        sameDocument: true
      })
    ).toEqual([])
    expect(
      nav.report('t1', TAB, {
        phase: 'started',
        url: 'https://down.test/#retry',
        sameDocument: true
      })
    ).toEqual([])
    // The next document of the page's own brings the family back.
    nav.report('t1', TAB, { phase: 'started', url: 'https://up.test/' })
    expect(
      names(nav.report('t1', TAB, { phase: 'completed', url: 'https://up.test/', committed: true }))
    ).toEqual(['onCommitted'])
    expect(names(nav.report('t1', TAB, { phase: 'load', url: 'https://up.test/' }))).toEqual([
      'onCompleted'
    ])
    // A navigation that never committed (cancelled) is an aborted one; the document stays.
    nav.report('t1', TAB, { phase: 'started', url: 'https://slow.test/' })
    const aborted = nav.report('t1', TAB, {
      phase: 'completed',
      url: 'https://slow.test/',
      committed: false
    })
    expect(aborted[0].details).toMatchObject({ error: 'net::ERR_ABORTED' })
    expect(
      names(
        nav.report('t1', TAB, { phase: 'started', url: 'https://up.test/#a', sameDocument: true })
      )
    ).toEqual(['onReferenceFragmentUpdated'])
  })

  it('tells fragment navigations from history state updates by the URL it last saw', () => {
    const nav = new AndroidWebNavigation(() => 0)
    nav.report('t1', TAB, { phase: 'started', url: 'https://a.test/page' })
    nav.report('t1', TAB, { phase: 'completed', url: 'https://a.test/page', committed: true })
    const fragment = nav.report('t1', TAB, {
      phase: 'started',
      url: 'https://a.test/page#top',
      sameDocument: true
    })
    expect(names(fragment)).toEqual(['onReferenceFragmentUpdated'])
    expect(fragment[0].details).toMatchObject({ transitionType: 'link', transitionQualifiers: [] })
    const pushed = nav.report('t1', TAB, {
      phase: 'started',
      url: 'https://a.test/other',
      sameDocument: true
    })
    expect(names(pushed)).toEqual(['onHistoryStateUpdated'])
    // The same-document navigation's `completed` adds nothing.
    expect(
      nav.report('t1', TAB, {
        phase: 'completed',
        url: 'https://a.test/other',
        sameDocument: true,
        committed: true
      })
    ).toEqual([])
  })

  it('infers the family from the client callbacks without the listener', () => {
    const nav = new AndroidWebNavigation(() => 0)
    const commit = nav.inferredCommit('t1', TAB, 'https://a.test/', false)
    expect(names(commit)).toEqual(['onBeforeNavigate', 'onCommitted'])
    expect(commit[1].details).toMatchObject({ transitionType: 'link', transitionQualifiers: [] })
    expect(names(nav.inferredFinish('t1', TAB, 'https://a.test/'))).toEqual([
      'onDOMContentLoaded',
      'onCompleted'
    ])
    expect(names(nav.inferredCommit('t1', TAB, 'https://a.test/#x', true))).toEqual([
      'onReferenceFragmentUpdated'
    ])
    const failed = nav.inferredFailure('t1', TAB, 'https://b.test/', 'net::ERR_CONNECTION_REFUSED')
    expect(names(failed)).toEqual(['onErrorOccurred'])
    // As measured on WebView 113 after a failed load: WebView's own error page finishes under
    // the failed URL (its commit never reaches the runtime), the core's `zen://error` page
    // commits and finishes, and a `pushState` on it reports under a `data:` URL. None of it is
    // the extension's business (Chrome hides `chrome-error://`); the next document of the
    // page's own is.
    expect(nav.inferredFinish('t1', TAB, 'https://b.test/')).toEqual([])
    expect(nav.inferredCommit('t1', TAB, 'zen://error?u', false)).toEqual([])
    expect(nav.inferredFinish('t1', TAB, 'zen://error?u')).toEqual([])
    expect(nav.inferredCommit('t1', TAB, 'data:text/html;charset=utf-8;base64,', true)).toEqual([])
    expect(names(nav.inferredCommit('t1', TAB, 'https://c.test/', false))).toEqual([
      'onBeforeNavigate',
      'onCommitted'
    ])
    expect(names(nav.inferredFinish('t1', TAB, 'https://c.test/'))).toEqual([
      'onDOMContentLoaded',
      'onCompleted'
    ])
    // A tab that fails, then loads the same URL fine (the server came back) is not hidden for good.
    nav.inferredFailure('t2', TAB, 'https://flaky.test/', 'net::ERR_CONNECTION_RESET')
    expect(nav.inferredFinish('t2', TAB, 'https://flaky.test/')).toEqual([])
    nav.inferredCommit('t2', TAB, 'https://flaky.test/', false)
    expect(names(nav.inferredFinish('t2', TAB, 'https://flaky.test/'))).toEqual([
      'onDOMContentLoaded',
      'onCompleted'
    ])
  })

  it('checks the view event payload', () => {
    expect(
      navigationReport({
        phase: 'started',
        url: 'https://a.test/',
        reload: true,
        sameDocument: false
      })
    ).toEqual({
      phase: 'started',
      url: 'https://a.test/',
      reload: true
    })
    expect(navigationReport({ phase: 'nope', url: 'x' })).toBeNull()
    expect(navigationReport({ phase: 'load' })).toBeNull()
    expect(navigationReport(null)).toBeNull()
  })
})

async function withNavigation(h: Harness, listeners: string[]): Promise<void> {
  await h.runtime.attach(
    record(h, {}, manifest({ permissions: ['webNavigation', 'tabs', 'storage'] }))
  )
  backgroundUp(h, 'bg1', listeners)
}

function nav(h: Harness, tabId: string, payload: Record<string, unknown>): void {
  h.runtime.onViewEvent(tabId, 'navigation', payload as never)
}

describe('AndroidExtensionRuntime: webNavigation from the navigation listener', () => {
  it('uses the navigation reports when Kotlin has the listener, and ignores the inferred path', async () => {
    const h = harness({ navigationListener: true })
    await withNavigation(h, [
      'webNavigation.onBeforeNavigate',
      'webNavigation.onCommitted',
      'webNavigation.onCompleted',
      'webNavigation.onErrorOccurred'
    ])
    nav(h, 't1', { phase: 'started', url: 'https://example.com/next', byPage: true })
    // The client callback's commit adds no webNavigation of its own on this path.
    h.runtime.onViewEvent('t1', 'navigated', {
      url: 'https://example.com/next',
      title: '',
      inPage: false,
      canGoBack: true,
      canGoForward: false
    })
    nav(h, 't1', {
      phase: 'completed',
      url: 'https://example.com/next',
      committed: true,
      byPage: true
    })
    h.runtime.onViewEvent('t1', 'stopLoading', {
      url: 'https://example.com/next',
      title: '',
      canGoBack: true,
      canGoForward: false
    })
    nav(h, 't1', { phase: 'load', url: 'https://example.com/next' })
    expect(events(h, 'bg1', 'webNavigation.onBeforeNavigate')).toHaveLength(1)
    expect(events(h, 'bg1', 'webNavigation.onCommitted')).toHaveLength(1)
    expect(events(h, 'bg1', 'webNavigation.onCompleted')).toHaveLength(1)
    const committed = (
      events(h, 'bg1', 'webNavigation.onCommitted')[0].args as Array<Record<string, unknown>>
    )[0]
    expect(committed).toMatchObject({
      tabId: h.runtime.api.tabs.chromeIdFor('t1'),
      url: 'https://example.com/next',
      transitionType: 'link'
    })
    h.runtime.onViewEvent('t1', 'failLoad', {
      code: -105,
      description: 'ERR_NAME_NOT_RESOLVED',
      url: 'https://x.test/'
    })
    expect(events(h, 'bg1', 'webNavigation.onErrorOccurred')).toHaveLength(0)
    nav(h, 't1', {
      phase: 'completed',
      url: 'https://x.test/',
      committed: false,
      error: 'net::ERR_NAME_NOT_RESOLVED'
    })
    expect(events(h, 'bg1', 'webNavigation.onErrorOccurred')).toHaveLength(1)
  })

  it('infers from the client callbacks on a WebView without the listener, with Chrome’s error names', async () => {
    const h = harness()
    await withNavigation(h, [
      'webNavigation.onBeforeNavigate',
      'webNavigation.onCommitted',
      'webNavigation.onDOMContentLoaded',
      'webNavigation.onCompleted',
      'webNavigation.onErrorOccurred'
    ])
    // Reports that arrive anyway (none should) are ignored on this path.
    nav(h, 't1', { phase: 'started', url: 'https://example.com/other' })
    expect(events(h, 'bg1', 'webNavigation.onBeforeNavigate')).toHaveLength(0)
    h.runtime.onViewEvent('t1', 'navigated', {
      url: 'https://example.com/next',
      title: '',
      inPage: false,
      canGoBack: true,
      canGoForward: false
    })
    expect(events(h, 'bg1', 'webNavigation.onBeforeNavigate')).toHaveLength(1)
    expect(events(h, 'bg1', 'webNavigation.onCommitted')).toHaveLength(1)
    h.runtime.onViewEvent('t1', 'stopLoading', {
      url: 'https://example.com/next',
      title: '',
      canGoBack: true,
      canGoForward: false
    })
    expect(events(h, 'bg1', 'webNavigation.onDOMContentLoaded')).toHaveLength(1)
    expect(events(h, 'bg1', 'webNavigation.onCompleted')).toHaveLength(1)
    h.runtime.onViewEvent('t1', 'failLoad', {
      code: -105,
      description: 'ERR_NAME_NOT_RESOLVED',
      url: 'https://x.test/'
    })
    const failed = events(h, 'bg1', 'webNavigation.onErrorOccurred')
    expect(failed).toHaveLength(1)
    expect((failed[0].args as Array<Record<string, unknown>>)[0]).toMatchObject({
      url: 'https://x.test/',
      error: 'net::ERR_NAME_NOT_RESOLVED'
    })
  })

  it('addresses filtered listeners by their UrlFilters and keeps unfiltered ones whole', async () => {
    const h = harness({ navigationListener: true })
    await withNavigation(h, [])
    // One unfiltered listener and two filtered ones (ids 1 and 2) on the same event.
    message(h, 'bg1', { t: 'listen', event: 'webNavigation.onCommitted', on: true })
    message(h, 'bg1', {
      t: 'listen',
      event: 'webNavigation.onCommitted',
      on: true,
      filterId: 1,
      filters: [{ hostSuffix: 'example.com' }]
    })
    message(h, 'bg1', {
      t: 'listen',
      event: 'webNavigation.onCommitted',
      on: true,
      filterId: 2,
      filters: [{ pathPrefix: '/docs' }]
    })
    nav(h, 't1', { phase: 'completed', url: 'https://www.example.com/docs/a', committed: true })
    nav(h, 't1', { phase: 'completed', url: 'https://other.test/', committed: true })
    const committed = events(h, 'bg1', 'webNavigation.onCommitted')
    expect(committed).toHaveLength(2)
    expect(committed[0].delivery).toEqual({ unfiltered: true, matched: [1, 2] })
    expect(committed[1].delivery).toEqual({ unfiltered: true, matched: [] })

    // Without the unfiltered listener, an event no filter matches is not sent at all.
    message(h, 'bg1', { t: 'listen', event: 'webNavigation.onCommitted', on: false })
    nav(h, 't1', { phase: 'completed', url: 'https://other.test/two', committed: true })
    expect(events(h, 'bg1', 'webNavigation.onCommitted')).toHaveLength(2)
    nav(h, 't1', { phase: 'completed', url: 'https://a.example.com/', committed: true })
    const third = events(h, 'bg1', 'webNavigation.onCommitted')[2]
    expect(third.delivery).toEqual({ unfiltered: false, matched: [1] })
    // Removing a filtered listener by its id.
    message(h, 'bg1', { t: 'listen', event: 'webNavigation.onCommitted', on: false, filterId: 1 })
    nav(h, 't1', { phase: 'completed', url: 'https://b.example.com/', committed: true })
    expect(events(h, 'bg1', 'webNavigation.onCommitted')).toHaveLength(3)
  })

  it('keeps a private tab’s navigations from an extension not allowed in it', async () => {
    const h = harness({ navigationListener: true })
    await withNavigation(h, ['webNavigation.onCommitted'])
    h.tabs.p1 = makeTab('p1', 'https://secret.example/', 'private')
    h.notifyState()
    nav(h, 'p1', { phase: 'completed', url: 'https://secret.example/page', committed: true })
    expect(events(h, 'bg1', 'webNavigation.onCommitted')).toHaveLength(0)
  })

  it('answers getAllFrames with the main frame from the tab and sub-frames from the content endpoints', async () => {
    const h = harness()
    await withNavigation(h, [])
    const tabId = h.runtime.api.tabs.chromeIdFor('t1')
    const reply = await callFrames(h, tabId)
    expect(reply).toEqual([
      expect.objectContaining({
        tabId,
        frameId: 0,
        parentFrameId: -1,
        url: 'https://example.com/',
        frameType: 'outermost_frame'
      })
    ])
    const frame = await callFrame(h, tabId, 0)
    expect(frame).toMatchObject({ frameId: 0, url: 'https://example.com/' })
    expect(await callFrame(h, tabId, 5)).toBeNull()
    expect(await callFrames(h, 999)).toBeNull()
  })
})

async function callFrames(h: Harness, tabId: number): Promise<unknown> {
  const reply = await call(h, 'bg1', 'webNavigation', 'getAllFrames', [{ tabId }])
  return reply.result
}

async function callFrame(h: Harness, tabId: number, frameId: number): Promise<unknown> {
  const reply = await call(h, 'bg1', 'webNavigation', 'getFrame', [{ tabId, frameId }])
  return reply.result
}
