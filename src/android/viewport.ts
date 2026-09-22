import type { PageRules } from '@shared/types'
import {
  needsViewportMeta,
  rewriteViewport,
  siteValue,
  zoomValue,
  type ViewportRewriteOptions
} from '@shared/pageControls'

/**
 * The page side of the page controls. Zoom, the desktop layout and force-zoom are all a matter
 * of the viewport meta: the layout viewport is narrowed by the zoom factor (a real reflow, the
 * way Chrome's page zoom works), widened to Chrome's 980 px desktop width for a desktop site,
 * and freed of `user-scalable=no` and a maximum scale when pinch zoom is forced. This runs at
 * document start with the host's copy of the rules, rewrites the page's own viewport meta as
 * the parser adds it (and any it adds later), supplies one when the page has none, and re-applies
 * when the rules change – the slider in the zoom sheet is live.
 *
 * The desktop layout alone is decided once, at document start, and kept for the document's
 * life (Chrome's rule: the desktop-site default follows the large-screen class at the tab's
 * load, not live resizes, and a loaded page never loses its scroll to one). The rules that
 * arrive live can change what the NEXT load of this page gets – a window crossing 600 dp into
 * or out of the large-screen class in split screen, another tab of the site switching it on –
 * but a document laid out for a phone keeps its width until it is reloaded, as it keeps the
 * user agent it was requested with (the host switches that at the next navigation too).
 *
 * Pages that zoom themselves (CSS `zoom`) are untouched: nothing here scales any element.
 */

export interface PageRulesConfig {
  rules: PageRules
  /** Width of the view in CSS px at scale 1 (`device-width`); 0 when unknown. */
  deviceWidth: number
}

/** What this page gets from the rules – the mirror of `resolvePageControls` for one URL. */
export function controlsFor(config: PageRulesConfig, url: string): ViewportRewriteOptions {
  const { rules } = config
  const web = /^https?:\/\//i.test(url)
  const base = web ? (zoomValue(rules.zoom.sites, url) ?? rules.zoom.default) : 1
  const zoom = web ? Math.round(base * (rules.zoom.scale || 1) * 1000) / 1000 : 1
  return {
    zoom: zoom > 0 && Number.isFinite(zoom) ? zoom : 1,
    desktop: web ? (siteValue(rules.desktop.sites, url) ?? rules.desktop.default) : false,
    forceZoom: web && rules.forceZoom,
    deviceWidth: config.deviceWidth > 0 ? config.deviceWidth : screenWidth()
  }
}

function screenWidth(): number {
  const w = typeof screen !== 'undefined' ? screen.width : 0
  return Number.isFinite(w) && w > 0 ? w : 0
}

const OWN_ATTRIBUTE = 'data-zenium-viewport'

export interface ViewportController {
  /**
   * New rules or a new view width: every viewport meta is rewritten from the page's original –
   * except that the desktop layout stays what this document started with (see the module note).
   */
  update(config: PageRulesConfig): void
  /** The options in force (tests). */
  current(): ViewportRewriteOptions
  /** Stop observing and hand the page its own metas back (tests). */
  dispose(): void
}

export function installViewportController(
  initial: PageRulesConfig,
  doc: Document = document
): ViewportController {
  let config = initial
  let options = controlsFor(config, doc.URL)
  /** The document's layout for its life: the desktop-site decision at its start (Chrome's rule). */
  const desktop = options.desktop
  /** The content each page-authored meta had before this controller touched it. */
  const originals = new WeakMap<Element, string>()
  /** What this controller last wrote, so its own mutations are not taken for the page's. */
  const written = new WeakMap<Element, string>()
  let own: HTMLMetaElement | null = null

  const isViewport = (el: Element): el is HTMLMetaElement =>
    el instanceof HTMLMetaElement && (el.getAttribute('name') ?? '').toLowerCase() === 'viewport'

  const pageMetas = (): HTMLMetaElement[] =>
    Array.from(doc.querySelectorAll('meta[name]'))
      .filter(isViewport)
      .filter((el) => !el.hasAttribute(OWN_ATTRIBUTE))

  /** The element is, or holds, a page-authored viewport meta (a subtree coming or going). */
  const holdsViewport = (el: Element): boolean =>
    (isViewport(el) && !el.hasAttribute(OWN_ATTRIBUTE)) ||
    Array.from(el.querySelectorAll('meta[name]')).some(
      (meta) => isViewport(meta) && !meta.hasAttribute(OWN_ATTRIBUTE)
    )

  /** Rewrite one page-authored meta; true when its content changed. */
  const apply = (el: HTMLMetaElement): boolean => {
    const now = el.getAttribute('content') ?? ''
    // First sight, or the page rewrote its own meta: that content is the original to derive from.
    if (!originals.has(el) || written.get(el) !== now) originals.set(el, now)
    const original = originals.get(el) ?? ''
    const next = rewriteViewport(original, options) ?? original
    written.set(el, next)
    if (next === now) return false
    el.setAttribute('content', next)
    return true
  }

  /**
   * A page with no viewport meta of its own gets one when the rules need it, and loses it again
   * otherwise; true when that changed anything.
   */
  const reconcileOwn = (): boolean => {
    const theirs = pageMetas()
    const head = doc.head
    if (theirs.length > 0 || !needsViewportMeta(options) || !head) {
      if (own && (theirs.length > 0 || !needsViewportMeta(options))) {
        own.remove()
        own = null
        return true
      }
      return false
    }
    const content = rewriteViewport(null, options)
    if (content === null) return false
    if (!own) {
      own = doc.createElement('meta')
      own.setAttribute('name', 'viewport')
      own.setAttribute(OWN_ATTRIBUTE, '')
      own.setAttribute('content', content)
      head.appendChild(own)
      return true
    }
    if (own.getAttribute('content') === content) return false
    own.setAttribute('content', content)
    return true
  }

  /**
   * Blink takes a viewport meta's new scale limits over at the page's next layout
   * (`WebViewImpl::ResizeAfterLayout`); only a change of the initial scale asks for one itself.
   * A page that has finished loading and lies still would keep pinching by its old limits – force
   * zoom freeing a `user-scalable=no` page, say, would wait for the page to move – so a rewrite
   * after load lays the page out once, with a probe that is gone again before anything paints.
   */
  const layOut = (): void => {
    const root = doc.documentElement
    if (!root || doc.readyState === 'loading') return
    const probe = doc.createElement('div')
    probe.setAttribute(OWN_ATTRIBUTE, '')
    probe.style.cssText =
      'position:fixed;top:0;left:0;width:1px;height:1px;visibility:hidden;pointer-events:none'
    root.appendChild(probe)
    void probe.offsetWidth
    probe.remove()
  }

  /** Every meta from its original; true when any content changed. */
  const applyAll = (): boolean => {
    let changed = false
    for (const el of pageMetas()) changed = apply(el) || changed
    return reconcileOwn() || changed
  }

  const applyAllAndLayOut = (): void => {
    if (applyAll()) layOut()
  }

  const observer = new MutationObserver((records) => {
    let structural = false
    let changed = false
    for (const r of records) {
      if (r.type === 'attributes') {
        const el = r.target as Element
        if (isViewport(el) && !el.hasAttribute(OWN_ATTRIBUTE)) changed = apply(el) || changed
        continue
      }
      for (const node of Array.from(r.addedNodes)) {
        if (node instanceof Element) {
          if (isViewport(node) && !node.hasAttribute(OWN_ATTRIBUTE)) {
            changed = apply(node) || changed
            structural = true
          } else if (node.tagName === 'HEAD' || holdsViewport(node)) {
            structural = true
          }
        }
      }
      // Only a page-authored viewport meta going (alone or inside a subtree) changes what the
      // page lays out by; the rest of the page's churn – and this controller's own meta and
      // layout probe, which come and go – asks for no scan of the document.
      for (const node of Array.from(r.removedNodes)) {
        if (node instanceof Element && holdsViewport(node)) structural = true
      }
    }
    if (structural) changed = applyAll() || changed
    if (changed) layOut()
  })
  observer.observe(doc, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['content', 'name']
  })

  applyAllAndLayOut()
  doc.addEventListener('DOMContentLoaded', applyAllAndLayOut, { once: true })

  return {
    update(next) {
      config = next
      options = { ...controlsFor(config, doc.URL), desktop }
      applyAllAndLayOut()
    },
    current: () => options,
    dispose() {
      observer.disconnect()
      doc.removeEventListener('DOMContentLoaded', applyAllAndLayOut)
      for (const el of pageMetas()) {
        const original = originals.get(el)
        if (original !== undefined) el.setAttribute('content', original)
      }
      own?.remove()
      own = null
    }
  }
}
