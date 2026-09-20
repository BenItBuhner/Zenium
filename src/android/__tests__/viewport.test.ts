// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PageRules } from '@shared/types'
import {
  controlsFor,
  installViewportController,
  type PageRulesConfig,
  type ViewportController
} from '../viewport'

function rules(patch: Partial<PageRules> = {}): PageRules {
  return {
    desktop: { default: false, sites: {} },
    darken: { default: false, sites: {} },
    zoom: { default: 1, sites: {}, scale: 1 },
    forceZoom: false,
    ...patch
  }
}

function config(patch: Partial<PageRules> = {}, deviceWidth = 412): PageRulesConfig {
  return { rules: rules(patch), deviceWidth }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function viewportMetas(): string[] {
  return Array.from(document.querySelectorAll('meta[name="viewport"]')).map(
    (m) => m.getAttribute('content') ?? ''
  )
}

function addMeta(content: string): HTMLMetaElement {
  const meta = document.createElement('meta')
  meta.setAttribute('name', 'viewport')
  meta.setAttribute('content', content)
  document.head.appendChild(meta)
  return meta
}

const live: ViewportController[] = []

/** One controller per document, as in a page; tests hand theirs in so none outlives its test. */
function install(c: PageRulesConfig): ViewportController {
  const controller = installViewportController(c)
  live.push(controller)
  return controller
}

beforeEach(() => {
  document.head.innerHTML = ''
  document.body.innerHTML = ''
  window.location.href = 'https://en.wikipedia.org/wiki/Zen'
})

afterEach(() => {
  for (const c of live.splice(0)) c.dispose()
})

describe('controlsFor', () => {
  it('mirrors the core resolution for the page URL', () => {
    const c = controlsFor(
      config({
        desktop: { default: false, sites: { 'wikipedia.org': true } },
        // Desktop site is per site (suffix match); zoom per host, exactly as Chrome keeps it.
        zoom: { default: 1.25, sites: { 'en.wikipedia.org': 1.5, 'wikipedia.org': 2 }, scale: 1.3 },
        forceZoom: true
      }),
      'https://en.wikipedia.org/'
    )
    expect(c).toEqual({ zoom: 1.95, desktop: true, forceZoom: true, deviceWidth: 412 })
    expect(
      controlsFor(
        config({ zoom: { default: 1.25, sites: { 'wikipedia.org': 2 }, scale: 1 } }),
        'https://fr.wikipedia.org/'
      ).zoom
    ).toBe(1.25)
    expect(controlsFor(config({ forceZoom: true }), 'zen://settings')).toMatchObject({
      zoom: 1,
      desktop: false,
      forceZoom: false
    })
  })
})

describe('the viewport controller', () => {
  it('rewrites the meta the parser adds and re-applies when the rules change', async () => {
    const controller = install(config({ zoom: { default: 1.25, sites: {}, scale: 1 } }))
    const meta = addMeta('width=device-width, initial-scale=1')
    await tick()
    expect(meta.getAttribute('content')).toBe('width=330, initial-scale=1.25')

    controller.update(config({ zoom: { default: 2, sites: {}, scale: 1 } }))
    expect(meta.getAttribute('content')).toBe('width=206, initial-scale=2')

    // Back to 100 percent: the page's original comes back exactly.
    controller.update(config())
    expect(meta.getAttribute('content')).toBe('width=device-width, initial-scale=1')
    expect(viewportMetas()).toHaveLength(1)
  })

  it('supplies a viewport meta for a page without one and removes it again', async () => {
    const controller = install(config({ desktop: { default: true, sites: {} } }))
    await tick()
    expect(viewportMetas()).toEqual(['width=980'])
    controller.update(config())
    expect(viewportMetas()).toEqual([])
  })

  it('gives way to the page’s own meta when it arrives late', async () => {
    install(config({ zoom: { default: 1.25, sites: {}, scale: 1 } }))
    await tick()
    expect(viewportMetas()).toEqual(['width=784'])
    addMeta('width=device-width')
    await tick()
    expect(viewportMetas()).toEqual(['width=330'])
  })

  it('treats a page rewriting its own meta as the new original', async () => {
    install(config({ zoom: { default: 1.5, sites: {}, scale: 1 } }))
    const meta = addMeta('width=device-width')
    await tick()
    expect(meta.getAttribute('content')).toBe('width=275')
    meta.setAttribute('content', 'width=device-width, maximum-scale=1')
    await tick()
    expect(meta.getAttribute('content')).toBe('width=275, maximum-scale=1.5')
  })

  it('leaves a page alone under default rules', async () => {
    install(config())
    const meta = addMeta('width=device-width, initial-scale=1, user-scalable=no')
    await tick()
    expect(meta.getAttribute('content')).toBe(
      'width=device-width, initial-scale=1, user-scalable=no'
    )
    expect(viewportMetas()).toHaveLength(1)
  })

  it('frees pinch zoom when it is forced', async () => {
    install(config({ forceZoom: true }))
    const meta = addMeta('width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no')
    await tick()
    expect(meta.getAttribute('content')).toBe('width=device-width, initial-scale=1')
  })

  it('lays a loaded page out once after a rewrite, leaving nothing behind', async () => {
    // Blink only pushes new scale limits to the compositor at a layout; a page that lies still
    // after load would keep its old ones. The probe that forces one must be gone again.
    const layouts: number[] = []
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get() {
        layouts.push(document.documentElement.childElementCount)
        return 0
      }
    })
    try {
      const controller = install(config())
      const meta = addMeta('width=device-width, maximum-scale=1, user-scalable=no')
      await tick()
      expect(layouts).toEqual([])

      controller.update(config({ forceZoom: true }))
      expect(meta.getAttribute('content')).toBe('width=device-width')
      // One layout, read while the probe was in the document (head, body and the probe).
      expect(layouts).toEqual([3])
      expect(document.documentElement.childElementCount).toBe(2)

      // Nothing to change, nothing to lay out.
      controller.update(config({ forceZoom: true }))
      expect(layouts).toEqual([3])
    } finally {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', descriptor)
      else delete (HTMLElement.prototype as { offsetWidth?: number }).offsetWidth
    }
  })

  it('scans the document again only when a viewport meta goes, not for the page’s own churn', async () => {
    install(config({ zoom: { default: 1.25, sites: {}, scale: 1 } }))
    const meta = addMeta('width=device-width')
    const banner = document.body.appendChild(document.createElement('div'))
    banner.appendChild(document.createElement('meta')).setAttribute('name', 'description')
    await tick()
    expect(viewportMetas()).toEqual(['width=330'])

    const scans = vi.spyOn(document, 'querySelectorAll')
    banner.remove()
    document.body.appendChild(document.createElement('p')).remove()
    await tick()
    expect(scans).not.toHaveBeenCalled()

    // The page taking its viewport meta away leaves the layout to the controller's own.
    meta.remove()
    await tick()
    expect(scans).toHaveBeenCalled()
    scans.mockRestore()
    expect(viewportMetas()).toEqual(['width=784'])
  })
})
