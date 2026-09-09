/**
 * The agent runtime that runs inside web pages: accessibility-style snapshots with element refs,
 * element location for trusted input, form filling, scrolling, waiting, and the visible cursor.
 *
 * `zenAgentPageRuntime` is serialised with `Function.prototype.toString()` and evaluated in the
 * page (Electron: the preload's isolated world; Android: the WebView's main world), exactly the way
 * Puppeteer and Playwright ship `page.evaluate` callbacks. It must therefore be self-contained:
 * no imports, no references to anything outside its own body, only syntax the bundlers leave
 * alone (ES2020 – no class fields, enums or decorators).
 */

export interface PageSnapshotOptions {
  agent: string
  interactiveOnly?: boolean
  filter?: string | null
  boxes?: boolean
  maxChars?: number
}

export interface PageSnapshot {
  url: string
  title: string
  viewport: { width: number; height: number }
  scroll: { x: number; y: number; height: number }
  tree: string
  refs: number
  truncated: boolean
}

export interface PageLocation {
  ref: string | null
  x: number
  y: number
  width: number
  height: number
  tag: string
  role: string
  name: string
  disabled: boolean
  editable: boolean
  /** Another element is painted over the target's centre (the click may land on it instead). */
  covered: boolean
  inViewport: boolean
}

export interface PageActionResult {
  ok: boolean
  error?: string
  value?: string
  scrollY?: number
}

export interface PageInfo {
  url: string
  title: string
  readyState: string
  viewport: { width: number; height: number }
  scroll: { x: number; y: number; height: number }
}

export interface PageCursorOptions {
  id: string
  name: string
  color: string
  x: number
  y: number
  action: 'move' | 'click' | 'show' | 'hide'
}

export interface PageRuntime {
  snapshot(opts: PageSnapshotOptions): PageSnapshot
  locate(agent: string, target: string, scroll: boolean): PageLocation | { error: string }
  fill(agent: string, target: string, text: string, clear: boolean): PageActionResult
  submit(agent: string, target: string): PageActionResult
  select(agent: string, target: string, values: string[]): PageActionResult
  clickJs(agent: string, target: string, count: number): PageActionResult
  keyJs(key: string, modifiers: string[]): PageActionResult
  scroll(
    agent: string,
    opts: {
      target?: string | null
      direction?: string | null
      amount?: number | null
      to?: string | null
    }
  ): PageActionResult
  waitFor(opts: {
    text?: string | null
    textGone?: string | null
    selector?: string | null
    timeout: number
  }): Promise<{ ok: boolean; elapsed: number; reason: string }>
  cursor(opts: PageCursorOptions): void
  info(): PageInfo
  text(maxChars: number): { title: string; text: string; truncated: boolean }
}

export const PAGE_RUNTIME_GLOBAL = '__zenAgentRuntime_v1'

export function zenAgentPageRuntime(): PageRuntime {
  interface RefState {
    byId: Map<string, Element>
    byEl: WeakMap<Element, string>
    seq: number
  }
  const REF_STATES: Record<string, RefState> = {}
  const MARK = 'data-zen-agent'
  const SKIP = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'TEMPLATE',
    'META',
    'LINK',
    'HEAD',
    'TITLE',
    'BASE',
    'PARAM',
    'SOURCE',
    'TRACK'
  ])
  const LEAF_ROLES = new Set([
    'textbox',
    'searchbox',
    'checkbox',
    'radio',
    'combobox',
    'slider',
    'spinbutton',
    'img',
    'progressbar',
    'meter',
    'separator',
    'option',
    'switch',
    'menuitemcheckbox',
    'menuitemradio'
  ])
  const INTERACTIVE_SELECTOR =
    'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=switch],[role=option],[role=combobox],[role=textbox],[role=slider],[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex="-1"]),[onclick]'

  const INPUT_ROLES: Record<string, string> = {
    button: 'button',
    submit: 'button',
    reset: 'button',
    image: 'button',
    checkbox: 'checkbox',
    radio: 'radio',
    range: 'slider',
    number: 'spinbutton',
    search: 'searchbox',
    email: 'textbox',
    tel: 'textbox',
    url: 'textbox',
    password: 'textbox',
    text: 'textbox',
    date: 'textbox',
    time: 'textbox',
    'datetime-local': 'textbox',
    month: 'textbox',
    week: 'textbox',
    color: 'button',
    file: 'button'
  }
  const TAG_ROLES: Record<string, string> = {
    A: 'link',
    BUTTON: 'button',
    SELECT: 'combobox',
    TEXTAREA: 'textbox',
    IMG: 'img',
    H1: 'heading',
    H2: 'heading',
    H3: 'heading',
    H4: 'heading',
    H5: 'heading',
    H6: 'heading',
    NAV: 'navigation',
    MAIN: 'main',
    HEADER: 'banner',
    FOOTER: 'contentinfo',
    ASIDE: 'complementary',
    FORM: 'form',
    SECTION: 'region',
    ARTICLE: 'article',
    UL: 'list',
    OL: 'list',
    LI: 'listitem',
    TABLE: 'table',
    TR: 'row',
    TD: 'cell',
    TH: 'columnheader',
    THEAD: 'rowgroup',
    TBODY: 'rowgroup',
    P: 'paragraph',
    BLOCKQUOTE: 'blockquote',
    SUMMARY: 'button',
    DETAILS: 'group',
    DIALOG: 'dialog',
    IFRAME: 'iframe',
    VIDEO: 'video',
    AUDIO: 'audio',
    OPTION: 'option',
    LABEL: 'label',
    FIGURE: 'figure',
    HR: 'separator',
    PROGRESS: 'progressbar',
    METER: 'meter',
    PRE: 'code',
    CODE: 'code'
  }

  const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim()
  const cut = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s)
  const q = (s: string, n = 120): string => JSON.stringify(cut(collapse(s), n))

  function refState(agent: string): RefState {
    let s = REF_STATES[agent]
    if (!s) {
      s = { byId: new Map(), byEl: new WeakMap(), seq: 0 }
      REF_STATES[agent] = s
    }
    return s
  }

  /**
   * A stable handle for an element: the same element keeps the same ref across snapshots, so a
   * ref handed out earlier still resolves until the element leaves the page. Disconnected
   * elements are pruned so ids do not leak.
   */
  function refFor(agent: string, el: Element): string {
    const s = refState(agent)
    const existing = s.byEl.get(el)
    if (existing && s.byId.get(existing) === el) return existing
    if (s.byId.size > 4000) {
      for (const [id, ref] of s.byId) if (!ref.isConnected) s.byId.delete(id)
    }
    const id = `e${++s.seq}`
    s.byId.set(id, el)
    s.byEl.set(el, id)
    return id
  }

  function isRendered(el: Element): boolean {
    if (el.hasAttribute(MARK) || el.closest(`[${MARK}]`)) return false
    if ((el as HTMLElement).hidden) return false
    if (el.getAttribute('aria-hidden') === 'true') return false
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    if (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'hidden') return false
    return true
  }

  function hasBox(el: Element): boolean {
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }

  function roleOf(el: Element): string | null {
    const explicit = el.getAttribute('role')
    if (explicit) return explicit.split(/\s+/)[0]
    const tag = el.tagName
    if (tag === 'INPUT') return INPUT_ROLES[(el as HTMLInputElement).type] ?? 'textbox'
    if (tag === 'A' && !(el as HTMLAnchorElement).href) return null
    if (tag === 'SECTION' && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby'))
      return null
    if (tag === 'FORM' && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby'))
      return 'form'
    if ((el as HTMLElement).isContentEditable && !TAG_ROLES[tag]) return 'textbox'
    return TAG_ROLES[tag] ?? null
  }

  function isInteractive(el: Element): boolean {
    try {
      return el.matches(INTERACTIVE_SELECTOR)
    } catch {
      return false
    }
  }

  function labelText(el: Element): string {
    const id = el.getAttribute('id')
    const parts: string[] = []
    if (id) {
      for (const l of Array.from(el.ownerDocument.querySelectorAll('label'))) {
        if (l.getAttribute('for') === id) parts.push(l.textContent ?? '')
      }
    }
    const wrapping = el.closest('label')
    if (wrapping && !parts.length) parts.push(wrapping.textContent ?? '')
    return collapse(parts.join(' '))
  }

  function nameOf(el: Element, role: string): { name: string; fromContent: boolean } {
    const aria = el.getAttribute('aria-label')
    if (aria && collapse(aria)) return { name: collapse(aria), fromContent: false }
    const labelledBy = el.getAttribute('aria-labelledby')
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '')
        .join(' ')
      if (collapse(text)) return { name: collapse(text), fromContent: false }
    }
    const tag = el.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      const label = labelText(el)
      if (label) return { name: label, fromContent: false }
      const input = el as HTMLInputElement
      const ph = el.getAttribute('placeholder')
      if (ph) return { name: collapse(ph), fromContent: false }
      if (tag === 'INPUT' && ['button', 'submit', 'reset'].includes(input.type) && input.value)
        return { name: collapse(input.value), fromContent: false }
      const title = el.getAttribute('title') ?? el.getAttribute('name')
      return { name: title ? collapse(title) : '', fromContent: false }
    }
    if (tag === 'IMG') {
      const alt = el.getAttribute('alt') ?? el.getAttribute('title') ?? ''
      return { name: collapse(alt), fromContent: false }
    }
    if (tag === 'IFRAME') {
      const t = el.getAttribute('title') ?? el.getAttribute('name') ?? el.getAttribute('src') ?? ''
      return { name: collapse(t), fromContent: false }
    }
    const title = el.getAttribute('title')
    if (
      [
        'navigation',
        'main',
        'banner',
        'contentinfo',
        'complementary',
        'region',
        'form',
        'list',
        'table',
        'rowgroup',
        'row',
        'group',
        'dialog',
        'figure',
        'article'
      ].includes(role)
    ) {
      return { name: title ? collapse(title) : '', fromContent: false }
    }
    const text = collapse((el as HTMLElement).innerText ?? el.textContent ?? '')
    if (text) return { name: text, fromContent: true }
    if (title) return { name: collapse(title), fromContent: false }
    const img = el.querySelector('img[alt], svg[aria-label], [aria-label]')
    if (img) {
      const a = img.getAttribute('alt') ?? img.getAttribute('aria-label') ?? ''
      if (collapse(a)) return { name: collapse(a), fromContent: false }
    }
    return { name: '', fromContent: false }
  }

  function attrsOf(el: Element, role: string, boxes: boolean): string {
    const out: string[] = []
    const tag = el.tagName
    if (role === 'heading') {
      const level = el.getAttribute('aria-level') ?? /^H([1-6])$/.exec(tag)?.[1] ?? ''
      if (level) out.push(`[level=${level}]`)
    }
    if (role === 'link') {
      const href = (el as HTMLAnchorElement).href
      if (href && !href.startsWith('javascript:')) out.push(`[href=${cut(href, 100)}]`)
    }
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      const input = el as HTMLInputElement
      if (input.type === 'checkbox' || input.type === 'radio') {
        if (input.checked) out.push('[checked]')
      } else if (input.type !== 'password' && input.value) {
        out.push(`[value=${q(input.value, 60)}]`)
      }
      if (
        input.type &&
        input.type !== 'text' &&
        tag === 'INPUT' &&
        !['checkbox', 'radio', 'button', 'submit'].includes(input.type)
      )
        out.push(`[type=${input.type}]`)
    } else if (tag === 'SELECT') {
      const sel = el as HTMLSelectElement
      const chosen = sel.selectedOptions[0]
      if (chosen) out.push(`[value=${q(chosen.label || chosen.value, 60)}]`)
      out.push(`[options=${sel.options.length}]`)
    } else if ((el as HTMLElement).isContentEditable) {
      const v = collapse((el as HTMLElement).innerText ?? '')
      if (v) out.push(`[value=${q(v, 60)}]`)
    }
    const checked = el.getAttribute('aria-checked')
    if (checked === 'true') out.push('[checked]')
    const pressed = el.getAttribute('aria-pressed')
    if (pressed === 'true') out.push('[pressed]')
    const expanded = el.getAttribute('aria-expanded')
    if (expanded) out.push(expanded === 'true' ? '[expanded]' : '[collapsed]')
    const selected = el.getAttribute('aria-selected')
    if (selected === 'true' || (tag === 'OPTION' && (el as HTMLOptionElement).selected))
      out.push('[selected]')
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true')
      out.push('[disabled]')
    if (tag === 'DETAILS') out.push((el as HTMLDetailsElement).open ? '[expanded]' : '[collapsed]')
    if (boxes) {
      const r = el.getBoundingClientRect()
      out.push(
        `[box=${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}]`
      )
    }
    return out.length ? ' ' + out.join(' ') : ''
  }

  function snapshot(opts: PageSnapshotOptions): PageSnapshot {
    const lines: string[] = []
    const maxChars = opts.maxChars ?? 30000
    const filter = opts.filter ? opts.filter.toLowerCase() : null
    const boxes = Boolean(opts.boxes)
    const interactiveOnly = Boolean(opts.interactiveOnly)
    let chars = 0
    let truncated = false
    let n = 0

    const emit = (line: string, depth: number): void => {
      if (truncated) return
      if (filter && !line.toLowerCase().includes(filter)) return
      const text = '  '.repeat(depth) + line
      chars += text.length + 1
      if (chars > maxChars) {
        truncated = true
        return
      }
      lines.push(text)
    }

    const visit = (node: Node, depth: number): void => {
      if (truncated) return
      if (node.nodeType === Node.TEXT_NODE) {
        if (interactiveOnly) return
        const t = collapse(node.textContent ?? '')
        if (t) emit(`- text: ${q(t, 200)}`, depth)
        return
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return
      const el = node as HTMLElement
      if (SKIP.has(el.tagName)) return
      if (el.tagName === 'SVG' || el.tagName === 'svg') {
        const label = el.getAttribute('aria-label') ?? el.querySelector('title')?.textContent ?? ''
        if (label && !interactiveOnly) emit(`- img ${q(label)}`, depth)
        return
      }
      if (!isRendered(el)) return
      const role = roleOf(el)
      const interactive = isInteractive(el)
      const children = (): void => {
        if (el.shadowRoot) for (const c of Array.from(el.shadowRoot.childNodes)) visit(c, depth)
        for (const c of Array.from(el.childNodes)) visit(c, depth)
      }
      if (role === null && !interactive) {
        children()
        return
      }
      if (!hasBox(el) && !el.shadowRoot && !(el.childElementCount > 0)) return
      const effectiveRole = role ?? 'clickable'
      if (interactiveOnly && !interactive && effectiveRole !== 'heading') {
        children()
        return
      }
      const { name, fromContent } = nameOf(el, effectiveRole)
      n++
      const ref = refFor(opts.agent, el)
      let line = `- ${effectiveRole}`
      if (name)
        line += ` ${q(name, effectiveRole === 'paragraph' || effectiveRole === 'listitem' || effectiveRole === 'code' || effectiveRole === 'blockquote' ? 400 : 120)}`
      line += attrsOf(el, effectiveRole, boxes)
      line += ` [ref=${ref}]`
      emit(line, depth)
      if (LEAF_ROLES.has(effectiveRole)) return
      if (fromContent) {
        // The label already carries the text; only descend for things that can be acted on.
        if (!el.querySelector(INTERACTIVE_SELECTOR)) return
        const inner = (node2: Node): void => {
          if (node2.nodeType !== Node.ELEMENT_NODE) return
          const c = node2 as Element
          if (isInteractive(c) && c !== el) {
            visit(c, depth + 1)
            return
          }
          for (const cc of Array.from(c.childNodes)) inner(cc)
        }
        for (const c of Array.from(el.childNodes)) inner(c)
        return
      }
      if (el.tagName === 'IFRAME') {
        try {
          const doc = (el as HTMLIFrameElement).contentDocument
          if (doc?.body) for (const c of Array.from(doc.body.childNodes)) visit(c, depth + 1)
        } catch {
          /* cross-origin */
        }
        return
      }
      const before = lines.length
      if (el.shadowRoot) for (const c of Array.from(el.shadowRoot.childNodes)) visit(c, depth + 1)
      for (const c of Array.from(el.childNodes)) visit(c, depth + 1)
      if (lines.length === before && !name && !interactive && !filter) {
        // An unnamed container with nothing inside adds noise – drop it again.
        lines.pop()
        n--
      }
    }

    if (document.body) visit(document.body, 0)
    if (truncated)
      lines.push(
        `… truncated at ${maxChars} characters – use browser_snapshot with a filter or interactiveOnly`
      )
    return {
      url: location.href,
      title: document.title,
      viewport: { width: innerWidth, height: innerHeight },
      scroll: {
        x: Math.round(scrollX),
        y: Math.round(scrollY),
        height: document.documentElement.scrollHeight
      },
      tree: lines.join('\n'),
      refs: n,
      truncated
    }
  }

  /** A <label> is a poor click target: redirect to the control it labels. */
  function preferControl(el: Element): Element {
    if (el.tagName !== 'LABEL') return el
    const label = el as HTMLLabelElement
    if (label.control) return label.control
    const forId = label.getAttribute('for')
    if (forId) {
      const target = el.ownerDocument.getElementById(forId)
      if (target) return target
    }
    return el.querySelector('input,select,textarea,button,[role],a[href]') ?? el
  }

  function resolve(agent: string, target: string): Element | { error: string } {
    const t = target.trim()
    if (!t) return { error: 'Empty target' }
    if (/^e\d+$/.test(t)) {
      const el = refState(agent).byId.get(t)
      if (!el) return { error: `Unknown ref ${t} – take a browser_snapshot first` }
      if (!el.isConnected)
        return {
          error: `Ref ${t} is stale (the element left the page) – take a new browser_snapshot`
        }
      return el
    }
    if (t.startsWith('text=')) {
      const needle = collapse(t.slice(5)).toLowerCase()
      if (!needle) return { error: 'Empty text= target' }
      // Match on the element's own direct text (not text that lives in a child) or its
      // aria-label, so "Sign in" matches the innermost label bearer, not the containers around it.
      const ownText = (c: HTMLElement): string => {
        let direct = ''
        for (const node of Array.from(c.childNodes))
          if (node.nodeType === Node.TEXT_NODE) direct += node.textContent ?? ''
        return collapse(direct).toLowerCase()
      }
      // Resolve a text bearer to the thing you would actually click: itself if interactive, else
      // the nearest interactive ancestor (a <span> inside a <button>), else a label's control.
      const clickTarget = (c: Element): Element => {
        let cur: Element | null = c
        for (let i = 0; cur && i < 4; i++) {
          if (isInteractive(cur)) return cur
          if (cur.tagName === 'LABEL') return preferControl(cur)
          cur = cur.parentElement
        }
        return preferControl(c)
      }
      let exact: Element | null = null
      let partial: Element | null = null
      for (const c of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
        if (SKIP.has(c.tagName) || !isRendered(c) || !hasBox(c)) continue
        const aria = collapse(c.getAttribute('aria-label') ?? '').toLowerCase()
        const text = aria || ownText(c)
        if (!text) continue
        // Later elements in document order are deeper / more specific, so keep the last match.
        if (text === needle) exact = c
        else if (!exact && text.includes(needle) && text.length < needle.length + 40) partial = c
      }
      const hit = exact ?? partial
      return hit
        ? clickTarget(hit)
        : { error: `No visible element with text ${JSON.stringify(t.slice(5))}` }
    }
    try {
      const el = document.querySelector(t)
      return el ? preferControl(el) : { error: `No element matches selector ${JSON.stringify(t)}` }
    } catch {
      return {
        error: `${JSON.stringify(t)} is neither a ref (e12), text=… nor a valid CSS selector`
      }
    }
  }

  function centre(el: Element): { x: number; y: number; r: DOMRect } {
    const r = el.getBoundingClientRect()
    const x = Math.min(Math.max(r.left + r.width / 2, r.left + 1), r.right - 1)
    const y = Math.min(Math.max(r.top + r.height / 2, r.top + 1), r.bottom - 1)
    return { x: Math.round(x), y: Math.round(y), r }
  }

  function locate(
    agent: string,
    target: string,
    scroll: boolean
  ): PageLocation | { error: string } {
    const el = resolve(agent, target)
    if (!(el instanceof Element)) return el
    if (!isRendered(el)) return { error: 'Element is hidden' }
    let { x, y, r } = centre(el)
    const inside = (): boolean =>
      r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth
    if (scroll && !inside()) {
      el.scrollIntoView({ block: 'center', inline: 'center' })
      ;({ x, y, r } = centre(el))
    }
    const role = roleOf(el) ?? (isInteractive(el) ? 'clickable' : 'generic')
    const hit = document.elementFromPoint(x, y)
    const covered = Boolean(hit && hit !== el && !el.contains(hit) && !hit.contains(el))
    const input = el as HTMLInputElement
    return {
      ref: /^e\d+$/.test(target.trim()) ? target.trim() : null,
      x,
      y,
      width: Math.round(r.width),
      height: Math.round(r.height),
      tag: el.tagName.toLowerCase(),
      role,
      name: nameOf(el, role).name,
      disabled: Boolean(input.disabled) || el.getAttribute('aria-disabled') === 'true',
      editable:
        el.tagName === 'TEXTAREA' ||
        (el.tagName === 'INPUT' &&
          !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color'].includes(
            input.type
          )) ||
        (el as HTMLElement).isContentEditable,
      covered,
      inViewport: r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth
    }
  }

  function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    const proto =
      el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const desc = Object.getOwnPropertyDescriptor(proto, 'value')
    if (desc?.set) desc.set.call(el, value)
    else el.value = value
  }

  function fill(agent: string, target: string, text: string, clear: boolean): PageActionResult {
    const el = resolve(agent, target)
    if (!(el instanceof Element)) return { ok: false, error: el.error }
    const h = el as HTMLElement
    h.focus()
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const input = el as HTMLInputElement
      if (input.disabled || input.readOnly)
        return { ok: false, error: 'Field is disabled or read-only' }
      if (input.type === 'checkbox' || input.type === 'radio')
        return { ok: false, error: 'Use browser_click for checkboxes and radios' }
      if (input.type === 'file') return { ok: false, error: 'File inputs cannot be filled' }
      const next = clear ? text : input.value + text
      setNativeValue(input, next)
      input.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })
      )
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return { ok: true, value: input.value }
    }
    if (el.tagName === 'SELECT')
      return { ok: false, error: 'Use browser_select_option for <select>' }
    if (h.isContentEditable) {
      if (clear) {
        const range = document.createRange()
        range.selectNodeContents(h)
        const sel = getSelection()
        sel?.removeAllRanges()
        sel?.addRange(range)
      }
      if (!document.execCommand('insertText', false, text)) {
        if (clear) h.textContent = ''
        h.appendChild(document.createTextNode(text))
        h.dispatchEvent(
          new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })
        )
      }
      return { ok: true, value: collapse(h.innerText) }
    }
    return {
      ok: false,
      error: `Cannot type into <${el.tagName.toLowerCase()}> – it is not an editable field`
    }
  }

  function keyEvent(type: string, key: string, modifiers: string[]): KeyboardEvent {
    const code =
      key.length === 1
        ? /[a-z]/i.test(key)
          ? `Key${key.toUpperCase()}`
          : /\d/.test(key)
            ? `Digit${key}`
            : key
        : key
    return new KeyboardEvent(type, {
      key,
      code,
      bubbles: true,
      cancelable: true,
      ctrlKey: modifiers.includes('Control'),
      altKey: modifiers.includes('Alt'),
      shiftKey: modifiers.includes('Shift'),
      metaKey: modifiers.includes('Meta')
    })
  }

  function submit(agent: string, target: string): PageActionResult {
    const el = resolve(agent, target)
    if (!(el instanceof Element)) return { ok: false, error: el.error }
    const h = el as HTMLElement
    h.focus()
    const notCancelled = h.dispatchEvent(keyEvent('keydown', 'Enter', []))
    h.dispatchEvent(keyEvent('keypress', 'Enter', []))
    h.dispatchEvent(keyEvent('keyup', 'Enter', []))
    const form = (el as HTMLInputElement).form
    if (form && notCancelled && el.tagName !== 'TEXTAREA') {
      if (typeof form.requestSubmit === 'function') form.requestSubmit()
      else form.submit()
    }
    return { ok: true }
  }

  function select(agent: string, target: string, values: string[]): PageActionResult {
    const el = resolve(agent, target)
    if (!(el instanceof Element)) return { ok: false, error: el.error }
    if (el.tagName !== 'SELECT') return { ok: false, error: 'Target is not a <select>' }
    const sel = el as HTMLSelectElement
    const wanted = values.map((v) => v.trim().toLowerCase())
    let matched = 0
    for (const opt of Array.from(sel.options)) {
      const hit =
        wanted.includes(opt.value.toLowerCase()) ||
        wanted.includes(collapse(opt.label || opt.text).toLowerCase())
      if (sel.multiple) opt.selected = hit
      else if (hit) {
        sel.value = opt.value
        matched++
        break
      }
      if (hit) matched++
    }
    if (!matched) {
      const available = Array.from(sel.options)
        .map((o) => collapse(o.label || o.text))
        .slice(0, 30)
      return {
        ok: false,
        error: `No option matches ${JSON.stringify(values)}. Options: ${available.join(' | ')}`
      }
    }
    sel.dispatchEvent(new Event('input', { bubbles: true }))
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, value: sel.selectedOptions[0]?.label ?? '' }
  }

  function inViewport(el: Element): boolean {
    const r = el.getBoundingClientRect()
    return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth
  }

  function clickJs(agent: string, target: string, count: number): PageActionResult {
    const el = resolve(agent, target)
    if (!(el instanceof Element)) return { ok: false, error: el.error }
    const h = el as HTMLElement
    if (!inViewport(el) && typeof el.scrollIntoView === 'function')
      el.scrollIntoView({ block: 'center', inline: 'center' })
    const { x, y } = centre(el)
    const init = {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 1,
      view: window
    }
    h.dispatchEvent(
      new PointerEvent('pointerover', {
        ...init,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true
      })
    )
    h.dispatchEvent(new MouseEvent('mouseover', init))
    h.dispatchEvent(
      new PointerEvent('pointerdown', {
        ...init,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true
      })
    )
    h.dispatchEvent(new MouseEvent('mousedown', init))
    h.focus()
    h.dispatchEvent(
      new PointerEvent('pointerup', {
        ...init,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        buttons: 0
      })
    )
    h.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }))
    // The native method runs the default action (toggles checkboxes, follows links, submits
    // forms) that a dispatched untrusted `click` event would not, and it works on hidden views.
    h.click()
    if (count >= 2) h.dispatchEvent(new MouseEvent('dblclick', { ...init, buttons: 0, detail: 2 }))
    return { ok: true }
  }

  function focusables(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR)).filter(
      (e) => isRendered(e) && hasBox(e) && !(e as HTMLInputElement).disabled && e.tabIndex >= 0
    )
  }

  function keyJs(key: string, modifiers: string[]): PageActionResult {
    const active = (document.activeElement as HTMLElement | null) ?? document.body
    const notCancelled = active.dispatchEvent(keyEvent('keydown', key, modifiers))
    if (
      key.length === 1 &&
      !modifiers.some((m) => m === 'Control' || m === 'Meta' || m === 'Alt')
    ) {
      active.dispatchEvent(keyEvent('keypress', key, modifiers))
    }
    if (notCancelled) {
      if (key === 'Enter') {
        const input = active as HTMLInputElement
        if (input.form && active.tagName === 'INPUT') {
          if (typeof input.form.requestSubmit === 'function') input.form.requestSubmit()
          else input.form.submit()
        } else if (
          active.tagName === 'BUTTON' ||
          active.tagName === 'A' ||
          active.getAttribute('role') === 'button'
        ) {
          active.click()
        }
      } else if (key === 'Tab') {
        const list = focusables()
        const i = list.indexOf(active)
        const next = modifiers.includes('Shift')
          ? (list[i - 1] ?? list[list.length - 1])
          : (list[i + 1] ?? list[0])
        next?.focus()
      } else if (key === 'Escape') {
        active.blur()
      } else if (
        key === ' ' &&
        (active.tagName === 'BUTTON' || (active as HTMLInputElement).type === 'checkbox')
      ) {
        active.click()
      } else if (
        key.length === 1 &&
        (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')
      ) {
        const input = active as HTMLInputElement
        setNativeValue(input, input.value + key)
        input.dispatchEvent(
          new InputEvent('input', { bubbles: true, inputType: 'insertText', data: key })
        )
      } else if (
        key === 'Backspace' &&
        (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')
      ) {
        const input = active as HTMLInputElement
        setNativeValue(input, input.value.slice(0, -1))
        input.dispatchEvent(
          new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' })
        )
      }
    }
    active.dispatchEvent(keyEvent('keyup', key, modifiers))
    return { ok: true }
  }

  function scroll(
    agent: string,
    opts: {
      target?: string | null
      direction?: string | null
      amount?: number | null
      to?: string | null
    }
  ): PageActionResult {
    if (opts.target) {
      const el = resolve(agent, opts.target)
      if (!(el instanceof Element)) return { ok: false, error: el.error }
      el.scrollIntoView({
        block: 'center',
        inline: 'nearest',
        behavior: 'instant' as ScrollBehavior
      })
      return { ok: true, scrollY: Math.round(scrollY) }
    }
    if (opts.to === 'top') window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
    else if (opts.to === 'bottom')
      window.scrollTo({
        top: document.documentElement.scrollHeight,
        behavior: 'instant' as ScrollBehavior
      })
    else {
      const amount = opts.amount && opts.amount > 0 ? opts.amount : Math.round(innerHeight * 0.8)
      const dir = opts.direction ?? 'down'
      const dx = dir === 'left' ? -amount : dir === 'right' ? amount : 0
      const dy = dir === 'up' ? -amount : dir === 'down' ? amount : 0
      window.scrollBy({ left: dx, top: dy, behavior: 'instant' as ScrollBehavior })
    }
    return { ok: true, scrollY: Math.round(scrollY) }
  }

  function waitFor(opts: {
    text?: string | null
    textGone?: string | null
    selector?: string | null
    timeout: number
  }): Promise<{ ok: boolean; elapsed: number; reason: string }> {
    const started = Date.now()
    const check = (): string | null => {
      const body = (document.body?.innerText ?? '').toLowerCase()
      if (opts.text && !body.includes(opts.text.toLowerCase()))
        return `text ${JSON.stringify(opts.text)} not on the page yet`
      if (opts.textGone && body.includes(opts.textGone.toLowerCase()))
        return `text ${JSON.stringify(opts.textGone)} still on the page`
      if (opts.selector) {
        try {
          if (!document.querySelector(opts.selector))
            return `no element matches ${JSON.stringify(opts.selector)}`
        } catch {
          return `invalid selector ${JSON.stringify(opts.selector)}`
        }
      }
      return null
    }
    return new Promise((done) => {
      const tick = (): void => {
        const pending = check()
        const elapsed = Date.now() - started
        if (!pending) return done({ ok: true, elapsed, reason: '' })
        if (elapsed >= opts.timeout) return done({ ok: false, elapsed, reason: pending })
        setTimeout(tick, 100)
      }
      tick()
    })
  }

  // --- the visible cursor --------------------------------------------------------------------

  function ensureStyle(): void {
    if (document.querySelector(`style[${MARK}="style"]`)) return
    const style = document.createElement('style')
    style.setAttribute(MARK, 'style')
    style.textContent = `
      @keyframes zenAgentRipple { from { transform: translate(-50%,-50%) scale(.35); opacity: .9 } to { transform: translate(-50%,-50%) scale(1.6); opacity: 0 } }
      @keyframes zenAgentPop { 0% { transform: scale(1) } 50% { transform: scale(.82) } 100% { transform: scale(1) } }
    `
    ;(document.head ?? document.documentElement).appendChild(style)
  }

  function cursorEl(opts: PageCursorOptions): HTMLElement {
    const id = `zen-agent-cursor-${opts.id}`
    let el = document.getElementById(id)
    if (el) {
      const tag = el.querySelector<HTMLElement>('[data-zen-agent="tag"]')
      if (tag && tag.textContent !== opts.name) tag.textContent = opts.name
      return el
    }
    ensureStyle()
    el = document.createElement('div')
    el.id = id
    el.setAttribute(MARK, 'cursor')
    el.setAttribute('aria-hidden', 'true')
    el.style.cssText = `position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;will-change:transform;transform:translate(${opts.x}px,${opts.y}px);transition:transform .38s cubic-bezier(.22,1,.36,1),opacity .25s ease;opacity:0;`
    const arrow = document.createElement('div')
    arrow.setAttribute(MARK, 'arrow')
    arrow.style.cssText =
      'position:absolute;left:0;top:0;width:22px;height:30px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45));transform-origin:2px 2px;'
    arrow.innerHTML = `<svg width="22" height="30" viewBox="0 0 22 30" xmlns="http://www.w3.org/2000/svg"><path d="M2 2 L2 24 L8.2 18.6 L12.6 28 L16.4 26.4 L12 17.2 L20 16.6 Z" fill="${opts.color}" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/></svg>`
    const tag = document.createElement('div')
    tag.setAttribute(MARK, 'tag')
    tag.textContent = opts.name
    tag.style.cssText = `position:absolute;left:18px;top:24px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:${opts.color};color:#fff;font:600 12px/1.2 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:4px 9px;border-radius:999px;box-shadow:0 2px 8px rgba(0,0,0,.35);letter-spacing:.01em;`
    el.appendChild(arrow)
    el.appendChild(tag)
    ;(document.body ?? document.documentElement).appendChild(el)
    // Two frames so the first move animates from the spawn point rather than jumping.
    requestAnimationFrame(() => {
      if (el) el.style.opacity = '1'
    })
    return el
  }

  function cursor(opts: PageCursorOptions): void {
    if (opts.action === 'hide') {
      document.getElementById(`zen-agent-cursor-${opts.id}`)?.remove()
      return
    }
    const el = cursorEl(opts)
    el.style.transform = `translate(${Math.round(opts.x)}px,${Math.round(opts.y)}px)`
    el.style.opacity = '1'
    if (opts.action === 'click') {
      const arrow = el.querySelector<HTMLElement>('[data-zen-agent="arrow"]')
      if (arrow) {
        arrow.style.animation = 'none'
        void arrow.offsetWidth
        arrow.style.animation = 'zenAgentPop .28s ease-out'
      }
      const ripple = document.createElement('div')
      ripple.setAttribute(MARK, 'ripple')
      ripple.style.cssText = `position:fixed;left:${Math.round(opts.x)}px;top:${Math.round(opts.y)}px;width:34px;height:34px;border-radius:50%;border:3px solid ${opts.color};box-shadow:0 0 0 2px rgba(255,255,255,.7) inset;pointer-events:none;z-index:2147483646;animation:zenAgentRipple .55s ease-out forwards;`
      ;(document.body ?? document.documentElement).appendChild(ripple)
      setTimeout(() => ripple.remove(), 600)
    }
  }

  function info(): PageInfo {
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      viewport: { width: innerWidth, height: innerHeight },
      scroll: {
        x: Math.round(scrollX),
        y: Math.round(scrollY),
        height: document.documentElement.scrollHeight
      }
    }
  }

  function text(maxChars: number): { title: string; text: string; truncated: boolean } {
    const clone = document.body ? (document.body.cloneNode(true) as HTMLElement) : null
    if (!clone) return { title: document.title, text: '', truncated: false }
    for (const junk of Array.from(
      clone.querySelectorAll(`script,style,noscript,template,[${MARK}]`)
    ))
      junk.remove()
    const raw = (document.body.innerText ?? clone.textContent ?? '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    return { title: document.title, text: raw.slice(0, maxChars), truncated: raw.length > maxChars }
  }

  return {
    snapshot,
    locate,
    fill,
    submit,
    select,
    clickJs,
    keyJs,
    scroll,
    waitFor,
    cursor,
    info,
    text
  }
}

/** Source of the runtime, ready to be evaluated in a page. */
export const PAGE_RUNTIME_SOURCE = `(${zenAgentPageRuntime.toString()})`

/**
 * Build a script that (re)installs the runtime if the page does not have it yet and invokes one
 * of its methods with JSON-encoded arguments. The result is the method's return value.
 */
export function pageCall(method: keyof PageRuntime, ...args: unknown[]): string {
  const argList = args.map((a) => JSON.stringify(a ?? null)).join(',')
  return `(() => { const g = globalThis; const rt = g[${JSON.stringify(PAGE_RUNTIME_GLOBAL)}] || (g[${JSON.stringify(PAGE_RUNTIME_GLOBAL)}] = ${PAGE_RUNTIME_SOURCE}()); return rt.${method}(${argList}) })()`
}
