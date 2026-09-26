/**
 * The page's own referrer policy, read in the page's world and told to the view ahead of a
 * navigation it may hold (W6-S9, the #507 delta read's item C).
 *
 * `TabWebView.holdForContentRules` cancels a navigation into a site the tab has no
 * content-settings answer for and re-issues it as the view's own load with a `Referer` it
 * computes itself (`ContentRules.resumeReferer`) – the request's own header is not readable in
 * the hook. Without the page's word that computation could only be Chrome's default policy,
 * over a page's stricter one. This module reads what page JS can see of the policy:
 *
 * - the DOCUMENT's: its `<meta name=referrer>` – the last valid one processed wins, an invalid
 *   value leaves the policy as it was, a removal changes nothing (the HTML spec's processing
 *   model; `document.referrerPolicy` is not exposed, so the meta is read from the DOM as it
 *   appears: at document start the document is empty, and every meta comes through the
 *   observer, a parser-inserted one before any inline script that follows it runs);
 * - the NAVIGATION's: the anchor a click / auxclick / Enter is about to follow – `rel=noreferrer`
 *   first, then its `referrerpolicy` attribute (an enumerated attribute: an unknown token is
 *   the empty string, the document's policy), then the document's.
 *
 * What page JS cannot see stays unread: a policy set by the `Referrer-Policy` response header
 * alone (the remaining gap, stated in the PR). The tokens are the Referrer Policy spec's; the
 * empty string stands for the default, which Kotlin computes as before.
 */

/** The eight tokens of the Referrer Policy spec; the empty string is the default policy. */
export type ReferrerPolicyToken =
  | ''
  | 'no-referrer'
  | 'no-referrer-when-downgrade'
  | 'same-origin'
  | 'origin'
  | 'strict-origin'
  | 'origin-when-cross-origin'
  | 'strict-origin-when-cross-origin'
  | 'unsafe-url'

const TOKENS: ReadonlySet<string> = new Set<string>([
  'no-referrer',
  'no-referrer-when-downgrade',
  'same-origin',
  'origin',
  'strict-origin',
  'origin-when-cross-origin',
  'strict-origin-when-cross-origin',
  'unsafe-url'
])

/**
 * The legacy keywords `<meta name=referrer>` alone still takes, as Blink maps them: `never`,
 * `always`, `origin-when-crossorigin`, and `default`, which is the browser's default policy
 * (Chromium's `kDefault`, today `strict-origin-when-cross-origin`), not a token of its own.
 */
const LEGACY_META_KEYWORDS: Readonly<Record<string, ReferrerPolicyToken>> = {
  never: 'no-referrer',
  always: 'unsafe-url',
  'origin-when-crossorigin': 'origin-when-cross-origin',
  default: ''
}

/** The word the view is told: the next navigation's policy, or the document's with its origin. */
export type ReferrerPolicyWord =
  | { next: ReferrerPolicyToken }
  | { document: ReferrerPolicyToken; origin: string }

/**
 * Parse a policy token as the spec does: ASCII case-insensitively (an enumerated attribute's
 * keywords), with the legacy meta keywords when `legacy` is set. Null for an unknown token –
 * the caller decides what an invalid value means where it stands (the meta: no change; the
 * anchor's attribute: the empty string).
 */
export function parseReferrerPolicy(
  value: string | null | undefined,
  legacy = false
): ReferrerPolicyToken | null {
  if (value === null || value === undefined) return null
  const token = value.trim().toLowerCase()
  if (token === '') return ''
  if (TOKENS.has(token)) return token as ReferrerPolicyToken
  if (legacy) {
    const mapped = LEGACY_META_KEYWORDS[token]
    if (mapped !== undefined) return mapped
  }
  return null
}

/** A `<meta name=referrer>` (the name matched ASCII case-insensitively) with a content attribute. */
function isReferrerMeta(node: Element): boolean {
  if (node.localName !== 'meta') return false
  const name = node.getAttribute('name')
  return name !== null && name.trim().toLowerCase() === 'referrer'
}

/**
 * The document's policy from its `<meta name=referrer>` elements, in tree order: the last valid
 * one wins; an invalid value leaves the one before it. The spec processes metas as they are
 * inserted or changed rather than in tree order, which for a document read whole is the same
 * order; [installReferrerPolicyReporter] follows the processing order live.
 */
export function documentMetaPolicy(doc: Document): ReferrerPolicyToken {
  let policy: ReferrerPolicyToken = ''
  for (const meta of Array.from(doc.querySelectorAll('meta[name]'))) {
    if (!isReferrerMeta(meta)) continue
    const parsed = parseReferrerPolicy(meta.getAttribute('content'), true)
    if (parsed !== null) policy = parsed
  }
  return policy
}

/** Whether the anchor's `rel` carries `noreferrer` (a space-separated, ASCII case-insensitive token list). */
function relNoReferrer(anchor: Element): boolean {
  const rel = anchor.getAttribute('rel')
  if (rel === null) return false
  return rel
    .split(/[\t\n\f\r ]+/)
    .some((token) => token.toLowerCase() === 'noreferrer')
}

/**
 * The policy a navigation from `anchor` runs under: `rel=noreferrer` is `no-referrer` over
 * everything; then the anchor's own `referrerpolicy` where it names a token (an unknown one is
 * the empty string, which defers to the document, as the IDL attribute reflects it); then
 * `documentPolicy`.
 */
export function anchorReferrerPolicy(
  anchor: Element,
  documentPolicy: ReferrerPolicyToken
): ReferrerPolicyToken {
  if (relNoReferrer(anchor)) return 'no-referrer'
  const own = parseReferrerPolicy(anchor.getAttribute('referrerpolicy'))
  if (own !== null && own !== '') return own
  return documentPolicy
}

/**
 * The anchor the event is about to follow in this frame: the nearest `a` / `area` with an
 * `href` on the event's composed path (a link inside a shadow root is found too), and only one
 * whose navigation is this document's own – not a `download`, not a `target` naming a new
 * window or another frame (those the view does not hold from here).
 */
export function navigatingAnchorOf(event: Event, doc: Document): Element | null {
  const path =
    typeof event.composedPath === 'function'
      ? event.composedPath()
      : event.target instanceof Node
        ? [event.target]
        : []
  let anchor: Element | null = null
  for (const node of path) {
    if (!(node instanceof Element)) continue
    if ((node.localName === 'a' || node.localName === 'area') && node.hasAttribute('href')) {
      anchor = node
      break
    }
  }
  if (anchor === null && event.target instanceof Element) {
    anchor = event.target.closest('a[href], area[href]')
  }
  if (anchor === null || anchor.ownerDocument !== doc) return null
  if (anchor.hasAttribute('download')) return null
  const target = (anchor.getAttribute('target') ?? '').trim().toLowerCase()
  if (target !== '' && target !== '_self' && target !== '_top' && target !== '_parent') return null
  return anchor
}

/**
 * Install in the top document: the document's word at once (the empty policy of a document
 * without a meta included, so a word of another document of the same origin is replaced) and
 * at every change the observer sees, following the spec's processing order – a meta inserted
 * or whose `content` / `name` changed with a valid value sets the policy, an invalid one and a
 * removal leave it; the next navigation's word at a capture-phase click, auxclick or Enter on
 * an anchor of this document's own, before the navigation it starts leaves the renderer. A
 * click the page prevents is told again as the document's word at the bubble phase's end, so
 * a `location.assign` the page runs in the link's place LATER (after a confirm, a fetch) is not
 * held under the link's policy; one the preventing handler runs at once has already left the
 * renderer under the link's word – a page that gives a link its own policy and then navigates
 * by script instead is the one shape left out.
 */
export function installReferrerPolicyReporter(
  w: Window,
  send: (word: ReferrerPolicyWord) => void
): void {
  const doc = w.document
  let documentPolicy: ReferrerPolicyToken = ''
  const origin = w.location.origin
  const tellDocument = (): void => send({ document: documentPolicy, origin })

  /** A meta processed (inserted, or its attribute changed): the spec's step, valid values only. */
  const processMeta = (meta: Element): void => {
    const parsed = parseReferrerPolicy(meta.getAttribute('content'), true)
    if (parsed === null || parsed === documentPolicy) return
    documentPolicy = parsed
    tellDocument()
  }

  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes') {
        const target = r.target
        if (target instanceof Element && isReferrerMeta(target)) processMeta(target)
        continue
      }
      for (const node of Array.from(r.addedNodes)) {
        if (!(node instanceof Element)) continue
        if (isReferrerMeta(node)) processMeta(node)
        else if (node.localName === 'head' || node.localName === 'html') {
          // A whole head arriving at once (a document written by script): its metas in order.
          for (const meta of Array.from(node.querySelectorAll('meta[name]'))) {
            if (isReferrerMeta(meta)) processMeta(meta)
          }
        }
      }
    }
  })
  observer.observe(doc, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['content', 'name']
  })
  // A script that arrived after the document started (a WebView without document-start
  // scripts, at page finished): the metas already there are read whole.
  const initial = documentMetaPolicy(doc)
  if (initial !== '') documentPolicy = initial
  tellDocument()

  const tellNext = (event: Event): void => {
    const anchor = navigatingAnchorOf(event, doc)
    if (anchor === null) return
    send({ next: anchorReferrerPolicy(anchor, documentPolicy) })
  }
  const onClick = (event: Event): void => {
    // An auxclick of the secondary button is the context menu's, not a navigation.
    if (event.type === 'auxclick' && event instanceof MouseEvent && event.button !== 1) return
    tellNext(event)
  }
  const onKeyDown = (event: Event): void => {
    if (!(event instanceof KeyboardEvent) || event.key !== 'Enter') return
    tellNext(event)
  }
  /** The page prevented the click at its own listeners: the link's word was for nothing. */
  const onPrevented = (event: Event): void => {
    if (!event.defaultPrevented || navigatingAnchorOf(event, doc) === null) return
    send({ next: documentPolicy })
  }
  w.addEventListener('click', onClick, true)
  w.addEventListener('auxclick', onClick, true)
  w.addEventListener('keydown', onKeyDown, true)
  w.addEventListener('click', onPrevented, false)
  w.addEventListener('auxclick', onPrevented, false)
  w.addEventListener('keydown', onPrevented, false)
}
