import type {
  TranslateBatch,
  TranslatePageSample,
  TranslateRuntimeStatus,
  TranslateTranslatedItem
} from './translate'

/**
 * The page side of translation: finds the text of a document, hands it out in batches, puts the
 * translations back with the inline markup intact and can undo all of it.
 *
 * `zenTranslatePageRuntime` is serialised with `Function.prototype.toString()` and evaluated in
 * the page (like the agent runtime), so it must be self-contained: no imports, no references to
 * module scope. The core drives it through `translateCall()` over the host's `executeJavaScript`
 * on every platform; nothing is pushed from the page. The core pulls batches (`next`), applies
 * translations (`apply`) and long-polls (`wait`) for content the mutation observer finds later.
 *
 * Text is grouped into units: a block element whose children are inline (a paragraph, a heading,
 * a list item, a table cell) or a run of inline siblings between block children. A unit is sent
 * as an HTML fragment in which every inline element is a `<span data-zt="i">` (or an `<img>` /
 * `<br>` for void and opaque elements), so Bergamot can move the markup with the words. The
 * translation is rebuilt around the page's own inline elements (links keep their handlers),
 * and the original nodes are kept for `revert`.
 */

export interface TranslateWaitResult {
  pending: number
  ended: boolean
}

export interface TranslatePageRuntime {
  /** Text for language detection: the first `maxChars` of visible text, viewport first. */
  sample(maxChars: number): TranslatePageSample
  /** Begin a session: collect the units and watch for new content. */
  start(session: number): TranslateRuntimeStatus
  /** The next units to translate, those in the viewport first. */
  next(session: number, maxItems: number, maxChars: number): TranslateBatch
  apply(session: number, items: TranslateTranslatedItem[]): TranslateRuntimeStatus
  /** Resolves when new units are pending, the session ends or `timeoutMs` passes. */
  wait(session: number, timeoutMs: number): Promise<TranslateWaitResult>
  /** Put the original content back and end the session. */
  revert(): TranslateRuntimeStatus
  status(): TranslateRuntimeStatus
  /** The user's current selection as plain text. */
  selection(maxChars: number): string
}

export const TRANSLATE_RUNTIME_GLOBAL = '__zenTranslateRuntime_v1'

export function zenTranslatePageRuntime(): TranslatePageRuntime {
  const BLOCK_TAGS = new Set([
    'ADDRESS',
    'ARTICLE',
    'ASIDE',
    'BLOCKQUOTE',
    'BODY',
    'BUTTON',
    'CAPTION',
    'CENTER',
    'DD',
    'DETAILS',
    'DIALOG',
    'DIR',
    'DIV',
    'DL',
    'DT',
    'FIELDSET',
    'FIGCAPTION',
    'FIGURE',
    'FOOTER',
    'FORM',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'HEADER',
    'HGROUP',
    'HR',
    'LEGEND',
    'LI',
    'MAIN',
    'MENU',
    'NAV',
    'OL',
    'OPTION',
    'P',
    'SECTION',
    'SUMMARY',
    'TABLE',
    'TBODY',
    'TD',
    'TFOOT',
    'TH',
    'THEAD',
    'TR',
    'UL'
  ])
  const INLINE_TAGS = new Set([
    'A',
    'ABBR',
    'ACRONYM',
    'B',
    'BDI',
    'BDO',
    'BIG',
    'BR',
    'CITE',
    'CODE',
    'DATA',
    'DEL',
    'DFN',
    'EM',
    'FONT',
    'I',
    'IMG',
    'INS',
    'KBD',
    'LABEL',
    'MARK',
    'NOBR',
    'OUTPUT',
    'Q',
    'RB',
    'RP',
    'RT',
    'RUBY',
    'S',
    'SAMP',
    'SMALL',
    'SPAN',
    'STRIKE',
    'STRONG',
    'SUB',
    'SUP',
    'TIME',
    'TT',
    'U',
    'VAR',
    'WBR'
  ])
  /** Subtrees that never hold translatable prose (or must not be touched). */
  const SKIP_TAGS = new Set([
    'AUDIO',
    'CANVAS',
    'EMBED',
    'IFRAME',
    'INPUT',
    'MATH',
    'META',
    'NOSCRIPT',
    'OBJECT',
    'PICTURE',
    'PRE',
    'SCRIPT',
    'SELECT',
    'STYLE',
    'SVG',
    'TEMPLATE',
    'TEXTAREA',
    'TITLE',
    'VIDEO'
  ])
  /** Inline elements whose content is kept verbatim (code, images, and anything marked no-translate). */
  const OPAQUE_TAGS = new Set(['CODE', 'KBD', 'SAMP', 'VAR', 'IMG', 'BR', 'WBR'])
  const VOID_TAGS = new Set(['BR', 'IMG', 'WBR'])
  const MAX_UNITS = 6000
  const RECT_SCAN = 1500
  const LETTER = /\p{L}/u

  const TEXT_NODE = 3
  const ELEMENT_NODE = 1

  interface Candidate {
    parent: Element
    nodes: Node[]
    text: string
  }

  interface Unit {
    id: number
    parent: Element
    /** The original nodes (a run of siblings inside `parent`). */
    nodes: Node[]
    /** Inline elements of the fragment by `data-zt` index, and what they originally contained. */
    inlines: Element[]
    inlineChildren: Node[][]
    inlineParents: number[]
    opaque: boolean[]
    /** For each inline, whether the source had whitespace right before and right after it. */
    spaced: [boolean, boolean][]
    /** Nodes standing in for `nodes` while translated. */
    current: Node[] | null
    state: 'pending' | 'sent' | 'done'
    /** The whole content of `parent` (as opposed to a run between block children). */
    whole: boolean
    /** The page changed the unit's content after it was translated; it is re-read and re-sent. */
    dirty: boolean
  }

  interface SessionState {
    id: number
    units: Unit[]
    byId: Map<number, Unit>
    owner: WeakMap<Node, Unit>
    claimed: WeakSet<Node>
    observer: MutationObserver | null
    ended: boolean
    wakers: (() => void)[]
    seq: number
  }

  let session: SessionState | null = null
  const doc = Math.floor(Math.random() * 0x7fffffff) + 1

  // ---------------------------------------------------------------------------
  // Classification
  // ---------------------------------------------------------------------------

  function tagOf(el: Element): string {
    return el.tagName.toUpperCase()
  }

  function isInline(el: Element): boolean {
    const tag = tagOf(el)
    if (INLINE_TAGS.has(tag)) return true
    if (BLOCK_TAGS.has(tag)) return false
    let display = ''
    try {
      display = getComputedStyle(el).display
    } catch {
      display = ''
    }
    return display === '' || display.startsWith('inline') || display === 'contents'
  }

  /** The nearest `attr` on `el` or an ancestor, lowercased ('' when set without a value). */
  function inherited(el: Element, attr: string): string | null {
    let current: Element | null = el
    while (current) {
      const value = current.getAttribute(attr)
      if (value !== null) return value.trim().toLowerCase()
      current = current.parentElement
    }
    return null
  }

  /** `translate="no"` (inherited) or Google's `notranslate` class. */
  function noTranslate(el: Element): boolean {
    const html = el as HTMLElement
    // The IDL attribute resolves inheritance; engines without it get the attribute walk.
    if (typeof html.translate === 'boolean') {
      if (!html.translate) return true
    } else if (inherited(el, 'translate') === 'no') return true
    return el.classList.contains('notranslate')
  }

  function editable(el: Element): boolean {
    // A positive IDL answer is trusted; a negative one is re-checked against the attribute since
    // not every engine resolves the empty value (`contenteditable=""`, meaning true) or inheritance.
    if ((el as HTMLElement).isContentEditable === true) return true
    let current: Element | null = el
    while (current) {
      const value = current.getAttribute('contenteditable')
      if (value !== null) {
        const normalized = value.trim().toLowerCase()
        if (normalized === 'false') return false
        if (normalized !== 'inherit') return true
      }
      current = current.parentElement
    }
    return false
  }

  /** Content that must not be touched: no-translate regions and editable ones. */
  function excluded(el: Element): boolean {
    return noTranslate(el) || editable(el)
  }

  function skipSubtree(el: Element): boolean {
    return SKIP_TAGS.has(tagOf(el)) || excluded(el)
  }

  function opaqueInline(el: Element): boolean {
    return OPAQUE_TAGS.has(tagOf(el)) || SKIP_TAGS.has(tagOf(el)) || excluded(el)
  }

  function worthTranslating(text: string): boolean {
    return LETTER.test(text)
  }

  function textOf(nodes: Node[]): string {
    let out = ''
    for (const node of nodes) out += node.textContent ?? ''
    return out.replace(/\s+/g, ' ').trim()
  }

  // ---------------------------------------------------------------------------
  // Collection
  // ---------------------------------------------------------------------------

  /**
   * Walk `root` and produce the translatable units below it: elements with inline content, and
   * runs of inline siblings inside elements that also hold block children. Nodes already owned by
   * a unit are skipped (`claimed`), so later walks of a subtree only find new content.
   */
  function collect(root: Element, out: Candidate[], claimed: WeakSet<Node> | null): void {
    if (out.length >= MAX_UNITS) return
    if (skipSubtree(root)) return
    if (claimed && claimed.has(root)) return
    let hasBlockChild = false
    for (let i = 0; i < root.children.length; i++) {
      const child = root.children[i]
      if (!isInline(child)) {
        hasBlockChild = true
        break
      }
    }
    if (!hasBlockChild) {
      const nodes = Array.from(root.childNodes).filter((node) => !claimed || !claimed.has(node))
      const text = textOf(nodes)
      if (worthTranslating(text) && !hiddenInlineOnly(nodes))
        out.push({ parent: root, nodes, text })
      return
    }
    let run: Node[] = []
    const flush = (): void => {
      if (run.length > 0) {
        const text = textOf(run)
        if (worthTranslating(text) && !hiddenInlineOnly(run))
          out.push({ parent: root, nodes: run, text })
      }
      run = []
    }
    for (const node of Array.from(root.childNodes)) {
      if (claimed && claimed.has(node)) {
        flush()
        continue
      }
      if (node.nodeType === ELEMENT_NODE && !isInline(node as Element)) {
        flush()
        collect(node as Element, out, claimed)
        if (out.length >= MAX_UNITS) return
      } else if (node.nodeType === TEXT_NODE || node.nodeType === ELEMENT_NODE) {
        run.push(node)
      }
    }
    flush()
  }

  /** A run whose only letters sit inside opaque inline elements (code, no-translate spans) is left alone. */
  function hiddenInlineOnly(nodes: Node[]): boolean {
    for (const node of nodes) {
      if (node.nodeType === TEXT_NODE) {
        if (worthTranslating(node.textContent ?? '')) return false
      } else if (node.nodeType === ELEMENT_NODE) {
        const el = node as Element
        if (!opaqueInline(el) && worthTranslating(el.textContent ?? '')) return false
      }
    }
    return true
  }

  // ---------------------------------------------------------------------------
  // Viewport ordering
  // ---------------------------------------------------------------------------

  function rectOf(parent: Element): DOMRect | null {
    try {
      return parent.getBoundingClientRect()
    } catch {
      return null
    }
  }

  /** 0 in the viewport, 1 rendered elsewhere (sorted by distance), 2 not rendered. */
  function priorityOf(parent: Element): [number, number] {
    const rect = rectOf(parent)
    if (!rect || (rect.width === 0 && rect.height === 0)) return [2, 0]
    const vh = window.innerHeight || 800
    if (rect.bottom > 0 && rect.top < vh) return [0, Math.max(0, rect.top)]
    return [1, rect.top >= vh ? rect.top - vh : -rect.bottom]
  }

  function orderByViewport<T extends { parent: Element }>(items: T[]): T[] {
    if (items.length <= 1) return items
    const scored = items.slice(0, RECT_SCAN).map((item, index) => {
      const [tier, distance] = priorityOf(item.parent)
      return { item, tier, distance, index }
    })
    scored.sort((a, b) => a.tier - b.tier || a.distance - b.distance || a.index - b.index)
    return scored.map((entry) => entry.item).concat(items.slice(RECT_SCAN))
  }

  // ---------------------------------------------------------------------------
  // Serialisation and rebuild
  // ---------------------------------------------------------------------------

  function escapeText(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  function serialize(unit: Unit): string {
    unit.inlines = []
    unit.inlineChildren = []
    unit.inlineParents = []
    unit.opaque = []
    unit.spaced = []
    let html = ''
    for (const node of unit.nodes) html += serializeNode(node, unit, -1)
    return html
  }

  function endsInSpace(node: Node | null): boolean {
    return node !== null && /\s$/.test(node.textContent ?? '')
  }

  function startsWithSpace(node: Node | null): boolean {
    return node !== null && /^\s/.test(node.textContent ?? '')
  }

  function serializeNode(node: Node, unit: Unit, parentIndex: number): string {
    if (node.nodeType === TEXT_NODE) return escapeText(node.textContent ?? '')
    if (node.nodeType !== ELEMENT_NODE) return ''
    const el = node as Element
    const index = unit.inlines.length
    const opaque = opaqueInline(el) || VOID_TAGS.has(tagOf(el))
    unit.inlines.push(el)
    unit.inlineChildren.push(opaque ? [] : Array.from(el.childNodes))
    unit.inlineParents.push(parentIndex)
    unit.opaque.push(opaque)
    unit.spaced.push([endsInSpace(el.previousSibling), startsWithSpace(el.nextSibling)])
    if (tagOf(el) === 'BR') return `<br data-zt="${index}">`
    if (opaque) return `<img data-zt="${index}">`
    let inner = ''
    for (const child of Array.from(el.childNodes)) inner += serializeNode(child, unit, index)
    return `<span data-zt="${index}">${inner}</span>`
  }

  function setChildren(el: Element, children: Node[]): void {
    while (el.firstChild) el.removeChild(el.firstChild)
    for (const child of children) el.appendChild(child)
  }

  /** Turn Bergamot's fragment back into page nodes, reusing the unit's own inline elements. */
  function rebuild(unit: Unit, html: string): Node[] {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const placed = new Set<number>()
    const top = buildChildren(doc.body, unit, placed)
    // Nothing may vanish: inline elements the translation dropped go back where they were.
    for (let i = 0; i < unit.inlines.length; i++) {
      if (placed.has(i)) continue
      const parentIndex = unit.inlineParents[i]
      if (parentIndex >= 0 && placed.has(parentIndex))
        unit.inlines[parentIndex].appendChild(unit.inlines[i])
      else if (parentIndex < 0) top.push(unit.inlines[i])
      placed.add(i)
    }
    return top
  }

  function buildChildren(from: Node, unit: Unit, placed: Set<number>): Node[] {
    const out: Node[] = []
    for (const child of Array.from(from.childNodes)) {
      if (child.nodeType === TEXT_NODE) {
        out.push(document.createTextNode(child.textContent ?? ''))
        continue
      }
      if (child.nodeType !== ELEMENT_NODE) continue
      const el = child as Element
      const attr = el.getAttribute('data-zt')
      const index = attr === null ? NaN : Number(attr)
      const original = Number.isInteger(index) ? unit.inlines[index] : undefined
      if (!original || placed.has(index)) {
        out.push(...buildChildren(el, unit, placed))
        continue
      }
      placed.add(index)
      if (!unit.opaque[index]) setChildren(original, buildChildren(el, unit, placed))
      out.push(original)
    }
    respaceOpaque(out, unit)
    return out
  }

  /** A letter or digit in a script that separates words with spaces. */
  function wordChar(text: string, last: boolean): boolean {
    const ch = last ? text.slice(-1) : text.slice(0, 1)
    return (
      /[\p{L}\p{N}]/u.test(ch) &&
      !/[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Thai}\p{sc=Lao}\p{sc=Khmer}\p{sc=Myanmar}]/u.test(
        ch
      )
    )
  }

  /**
   * The engine keeps opaque elements (no-translate spans, code, images) as tokens and tends to drop
   * the whitespace around them: "the <span translate=no>eBiblio</span> app" comes back as
   * "the appeBiblio". Where the source had a space on a side and the translation now puts a word
   * directly against the element, the space goes back.
   */
  function respaceOpaque(out: Node[], unit: Unit): void {
    for (let i = 0; i < out.length; i++) {
      const node = out[i]
      if (node.nodeType !== ELEMENT_NODE || tagOf(node as Element) === 'BR') continue
      const index = unit.inlines.indexOf(node as Element)
      if (index < 0 || !unit.opaque[index]) continue
      const [before, after] = unit.spaced[index] ?? [false, false]
      const prev = out[i - 1]
      const next = out[i + 1]
      if (before && prev && prev.nodeType === TEXT_NODE && wordChar(prev.textContent ?? '', true))
        prev.textContent = `${prev.textContent ?? ''} `
      if (after && next && next.nodeType === TEXT_NODE && wordChar(next.textContent ?? '', false))
        next.textContent = ` ${next.textContent ?? ''}`
    }
  }

  function applyUnit(unit: Unit, html: string | null): void {
    unit.state = 'done'
    if (html === null) return
    const first = unit.nodes[0]
    const last = unit.nodes[unit.nodes.length - 1]
    if (!first || !last || first.parentNode !== unit.parent) return
    const after = last.nextSibling
    for (const node of unit.nodes)
      if (node.parentNode === unit.parent) unit.parent.removeChild(node)
    const built = rebuild(unit, html)
    for (const node of built) unit.parent.insertBefore(node, after)
    unit.current = built
    if (session) for (const node of built) session.owner.set(node, unit)
  }

  function revertUnit(unit: Unit): void {
    const current = unit.current
    if (!current || current.length === 0) return
    unit.current = null
    const first = current[0]
    const parent = first.parentNode
    if (!parent) return
    const after = current[current.length - 1].nextSibling
    for (const node of current) if (node.parentNode === parent) parent.removeChild(node)
    for (let i = 0; i < unit.inlines.length; i++) {
      if (!unit.opaque[i]) setChildren(unit.inlines[i], unit.inlineChildren[i])
    }
    for (const node of unit.nodes) parent.insertBefore(node, after)
  }

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  function register(state: SessionState, candidate: Candidate): Unit {
    const unit: Unit = {
      id: ++state.seq,
      parent: candidate.parent,
      nodes: candidate.nodes,
      inlines: [],
      inlineChildren: [],
      inlineParents: [],
      opaque: [],
      spaced: [],
      current: null,
      state: 'pending',
      whole: candidate.nodes.length === candidate.parent.childNodes.length,
      dirty: false
    }
    state.units.push(unit)
    state.byId.set(unit.id, unit)
    for (const node of candidate.nodes) {
      state.claimed.add(node)
      state.owner.set(node, unit)
    }
    if (unit.whole) {
      state.claimed.add(candidate.parent)
      state.owner.set(candidate.parent, unit)
    }
    return unit
  }

  function ownerOf(state: SessionState, node: Node | null): Unit | null {
    let current: Node | null = node
    while (current && current !== document.body) {
      const unit = state.owner.get(current)
      if (unit) return unit
      current = current.parentNode
    }
    return null
  }

  function wake(state: SessionState): void {
    const wakers = state.wakers.splice(0)
    for (const waker of wakers) waker()
  }

  function onMutations(state: SessionState, records: MutationRecord[]): void {
    if (session !== state || state.ended) return
    let found = false
    const roots = new Set<Element>()
    for (const record of records) {
      if (record.type === 'characterData') {
        // Text edited inside a unit (a live counter, a clock) stays as the page wrote it; text
        // that appeared outside any unit is new content.
        if (!ownerOf(state, record.target) && record.target.parentElement)
          roots.add(record.target.parentElement)
        continue
      }
      for (const added of Array.from(record.addedNodes)) {
        const unit = ownerOf(state, added)
        if (unit) {
          if (unit.whole && unit.state === 'done' && !unit.dirty) {
            unit.dirty = true
            found = true
          }
          continue
        }
        if (added.nodeType === ELEMENT_NODE) roots.add(added as Element)
        else if (added.nodeType === TEXT_NODE && added.parentElement) roots.add(added.parentElement)
      }
    }
    for (const root of roots) {
      if (!root.isConnected) continue
      const candidates: Candidate[] = []
      collect(root, candidates, state.claimed)
      for (const candidate of candidates) {
        if (state.units.length >= MAX_UNITS) break
        register(state, candidate)
        found = true
      }
    }
    if (found) wake(state)
  }

  function statusOf(state: SessionState | null): TranslateRuntimeStatus {
    if (!state) return { doc, session: 0, total: 0, done: 0, pending: 0, ended: true }
    let done = 0
    let pending = 0
    for (const unit of state.units) {
      if (unit.state === 'done' && !unit.dirty) done++
      else if (unit.state === 'pending' || unit.dirty) pending++
    }
    return { doc, session: state.id, total: state.units.length, done, pending, ended: state.ended }
  }

  function end(state: SessionState): void {
    state.ended = true
    state.observer?.disconnect()
    state.observer = null
    wake(state)
  }

  /**
   * A dirty unit is re-read before it is sent again: the translation comes out (so nothing is
   * translated twice) and whatever the page holds now becomes the content to translate and to
   * revert to. When the page replaced the content outright, the old translation is simply gone.
   */
  function refresh(unit: Unit, state: SessionState): void {
    unit.dirty = false
    revertUnit(unit)
    unit.nodes = Array.from(unit.parent.childNodes)
    for (const node of unit.nodes) {
      state.claimed.add(node)
      state.owner.set(node, unit)
    }
  }

  const runtime: TranslatePageRuntime = {
    sample(maxChars: number): TranslatePageSample {
      const root = document.documentElement
      const body = document.body
      const langAttr = root?.getAttribute('lang') || body?.getAttribute('lang') || ''
      // Attribute values are matched by hand: not every engine honours the `i` selector flag.
      const metaNamed = (attr: string, name: string): Element | null => {
        for (const el of document.querySelectorAll(`meta[${attr}]`)) {
          if ((el.getAttribute(attr) ?? '').trim().toLowerCase() === name) return el
        }
        return null
      }
      const meta = metaNamed('http-equiv', 'content-language')
      const googleMeta = metaNamed('name', 'google')
      const googleValue = (
        googleMeta?.getAttribute('content') ||
        googleMeta?.getAttribute('value') ||
        ''
      ).toLowerCase()
      const notranslate =
        (root !== null && noTranslate(root)) || googleValue.split(/[\s,]+/).includes('notranslate')
      const sample: TranslatePageSample = {
        doc,
        text: '',
        lang: langAttr.trim(),
        contentLanguage: (meta?.getAttribute('content') ?? '').trim(),
        notranslate,
        chars: 0
      }
      if (!body) return sample
      const candidates: Candidate[] = []
      collect(body, candidates, null)
      let chars = 0
      for (const candidate of candidates) chars += candidate.text.length
      sample.chars = chars
      const parts: string[] = []
      let length = 0
      for (const candidate of orderByViewport(candidates)) {
        if (length >= maxChars) break
        const text = candidate.text.slice(0, maxChars - length)
        parts.push(text)
        length += text.length + 1
      }
      sample.text = parts.join('\n')
      return sample
    },

    start(id: number): TranslateRuntimeStatus {
      if (session) {
        for (const unit of session.units) revertUnit(unit)
        end(session)
      }
      const state: SessionState = {
        id,
        units: [],
        byId: new Map(),
        owner: new WeakMap(),
        claimed: new WeakSet(),
        observer: null,
        ended: false,
        wakers: [],
        seq: 0
      }
      session = state
      const body = document.body
      if (body) {
        const candidates: Candidate[] = []
        collect(body, candidates, null)
        for (const candidate of candidates) register(state, candidate)
        if (typeof MutationObserver === 'function') {
          state.observer = new MutationObserver((records) => onMutations(state, records))
          state.observer.observe(body, { childList: true, characterData: true, subtree: true })
        }
        window.addEventListener('pagehide', () => end(state), { once: true })
      }
      return statusOf(state)
    },

    next(id: number, maxItems: number, maxChars: number): TranslateBatch {
      const state = session
      const status = statusOf(state)
      if (!state || state.id !== id || state.ended)
        return { session: id, items: [], total: status.total, done: status.done }
      const pending = state.units.filter((unit) => unit.state === 'pending' || unit.dirty)
      const items: TranslateBatch['items'] = []
      let chars = 0
      for (const unit of orderByViewport(pending)) {
        if (items.length >= maxItems || (items.length > 0 && chars >= maxChars)) break
        if (unit.dirty) refresh(unit, state)
        if (!unit.nodes[0] || unit.nodes[0].parentNode !== unit.parent) {
          // The page removed it before we got to it.
          unit.state = 'done'
          continue
        }
        const html = serialize(unit)
        unit.state = 'sent'
        chars += html.length
        items.push({ id: unit.id, html })
      }
      const after = statusOf(state)
      return { session: id, items, total: after.total, done: after.done }
    },

    apply(id: number, items: TranslateTranslatedItem[]): TranslateRuntimeStatus {
      const state = session
      if (!state || state.id !== id || state.ended) return statusOf(state)
      for (const item of items) {
        const unit = state.byId.get(item.id)
        if (!unit || unit.state !== 'sent') continue
        try {
          applyUnit(unit, item.html)
        } catch {
          unit.state = 'done'
        }
      }
      // Our own edits are not new content.
      state.observer?.takeRecords()
      return statusOf(state)
    },

    wait(id: number, timeoutMs: number): Promise<TranslateWaitResult> {
      const state = session
      return new Promise((resolve) => {
        const finish = (): void => {
          const status = statusOf(session)
          resolve({
            pending: status.pending,
            ended: !state || state.id !== id || state.ended || session !== state
          })
        }
        if (!state || state.id !== id || state.ended || statusOf(state).pending > 0) {
          finish()
          return
        }
        let timer: ReturnType<typeof setTimeout> | null = null
        const waker = (): void => {
          if (timer !== null) clearTimeout(timer)
          finish()
        }
        timer = setTimeout(
          () => {
            state.wakers = state.wakers.filter((entry) => entry !== waker)
            finish()
          },
          Math.max(0, timeoutMs)
        )
        state.wakers.push(waker)
      })
    },

    revert(): TranslateRuntimeStatus {
      const state = session
      if (!state) return statusOf(null)
      for (const unit of state.units) revertUnit(unit)
      end(state)
      session = null
      return { ...statusOf(state), ended: true }
    },

    status(): TranslateRuntimeStatus {
      return statusOf(session)
    },

    selection(maxChars: number): string {
      const selection = document.getSelection()
      const text = selection ? String(selection) : ''
      return text.replace(/\s+/g, ' ').trim().slice(0, maxChars)
    }
  }

  return runtime
}

/** Source of the runtime, ready to be evaluated in a page. */
export const TRANSLATE_RUNTIME_SOURCE = `(${zenTranslatePageRuntime.toString()})`

/** What `translateCall` evaluates to when the page has no runtime yet (a new document). */
export const TRANSLATE_RUNTIME_MISSING = '__zenTranslateRuntimeMissing__'

function argumentList(args: unknown[]): string {
  return args.map((arg) => JSON.stringify(arg ?? null)).join(',')
}

/**
 * A script that invokes one method of the page's runtime with JSON-encoded arguments; the result
 * is the method's return value (or its promise), or `TRANSLATE_RUNTIME_MISSING` when the runtime
 * is not installed (then run `translateInstallCall` instead).
 */
export function translateCall(method: keyof TranslatePageRuntime, ...args: unknown[]): string {
  const key = JSON.stringify(TRANSLATE_RUNTIME_GLOBAL)
  return `(() => { const rt = globalThis[${key}]; return rt ? rt.${method}(${argumentList(args)}) : ${JSON.stringify(TRANSLATE_RUNTIME_MISSING)} })()`
}

/** Like `translateCall`, but carries the runtime and installs it first when it is missing. */
export function translateInstallCall(
  method: keyof TranslatePageRuntime,
  ...args: unknown[]
): string {
  const key = JSON.stringify(TRANSLATE_RUNTIME_GLOBAL)
  return `(() => { const g = globalThis; const rt = g[${key}] || (g[${key}] = ${TRANSLATE_RUNTIME_SOURCE}()); return rt.${method}(${argumentList(args)}) })()`
}
