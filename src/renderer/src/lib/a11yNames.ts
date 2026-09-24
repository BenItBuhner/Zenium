/**
 * Spoken names against visible text (A11Y-10). Voice Access acts on what a user reads off the
 * screen and says – "tap Reload" – by matching the words to the control's accessible name, and
 * Switch Access speaks that name as its scanning lands on the control; so a control that shows
 * text must carry that text in its name, and one that shows a glyph alone must have a name, the
 * word the user would say. The text a user reads and says is the control's leading text – the
 * pill's "example.com", a card's title, a group header's name – and the name may say more
 * around it ("Address, example.com, Secure"; "Alpha, tab 1 of 6, current"; "Research, tab
 * group, 2 tabs") and leave the secondary lines out (the host under a card's title is context,
 * not the name). The audit reads a rendered chrome: every control (a button, a tab, a link, a
 * checkbox or switch, a menu item) that a reader would be given – not under `aria-hidden` – and
 * answers with what falls short. The renderer's tests run it over the phone's surfaces; the
 * device harness (`ChromeA11yDemo`) asks the same of the live chrome in its own words.
 */

export type NameIssue = 'unnamed' | 'mismatch'

export interface NameFinding {
  /** A short description of the element: tag, class and data attributes, for the failure line. */
  where: string
  /** The accessible name as a reader would take it (empty when the control has none). */
  name: string
  /** The text the control shows, whitespace-normalised (empty for a glyph alone). */
  visible: string
  issue: NameIssue
}

/** The controls the audit reads: what a voice or switch user would act on. */
export const CONTROL_SELECTOR =
  'button, [role="button"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], ' +
  '[role="menuitemradio"], [role="checkbox"], [role="switch"], [role="radio"], [role="option"], ' +
  '[role="link"], a[href], input:not([type="hidden"]), select, textarea'

const normalise = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** Whether a reader would be given the element at all: not itself or under `aria-hidden`. */
export function exposed(el: Element): boolean {
  return el.closest('[aria-hidden="true"]') === null
}

/**
 * The pieces of text the element shows, in reading order, as a reader would take them out of
 * its content: one per text node (an image's `alt` counts as one), `aria-hidden` parts left out
 * (a glyph's fallback text, a decorative mark), empty ones dropped and a piece repeated (a title
 * drawn twice, in a card's header and its stand-in picture) kept once.
 */
export function visiblePiecesOf(el: Element): string[] {
  const pieces: string[] = []
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = normalise(node.textContent ?? '')
      if (text && !pieces.includes(text)) pieces.push(text)
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const element = node as Element
    if (element.getAttribute('aria-hidden') === 'true') return
    if (element.tagName === 'IMG') {
      const alt = normalise(element.getAttribute('alt') ?? '')
      if (alt && !pieces.includes(alt)) pieces.push(alt)
      return
    }
    for (const child of element.childNodes) visit(child)
  }
  for (const child of el.childNodes) visit(child)
  return pieces
}

/** The text the element shows, its pieces ([visiblePiecesOf]) joined by a space. */
export function visibleTextOf(el: Element): string {
  return visiblePiecesOf(el).join(' ')
}

/**
 * The element's accessible name as the platform computes it, in the order that matters here:
 * `aria-label`, then `aria-labelledby`'s targets' text, then – for a form control – its
 * `<label>`, `placeholder` or `title`, then the content (every control the audit reads is named
 * from its content when nothing names it otherwise; a link's or a button's text). Empty when
 * nothing names it.
 */
export function accessibleNameOf(el: Element): string {
  const label = el.getAttribute('aria-label')
  if (label && normalise(label)) return normalise(label)
  const labelledBy = el.getAttribute('aria-labelledby')
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '')
      .map(normalise)
      .filter(Boolean)
      .join(' ')
    if (text) return text
  }
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLSelectElement ||
    el instanceof HTMLTextAreaElement
  ) {
    const fromLabels = [...(el.labels ?? [])]
      .map((l) => normalise(l.textContent ?? ''))
      .filter(Boolean)
    if (fromLabels.length) return fromLabels.join(' ')
    const placeholder = el.getAttribute('placeholder')
    if (placeholder && normalise(placeholder)) return normalise(placeholder)
  }
  const title = el.getAttribute('title')
  const content = visibleTextOf(el)
  if (content) return content
  return title ? normalise(title) : ''
}

/**
 * Whether `name` carries `visible`: the same words, or the visible text as a whole inside the
 * name, letter case aside – "Tabs (6)" carries "6", "Alpha, tab 1 of 6, current" carries "Alpha".
 */
export function nameCarries(name: string, visible: string): boolean {
  if (!visible) return true
  return normalise(name).toLowerCase().includes(normalise(visible).toLowerCase())
}

/**
 * The text a user reads off the control and says: its leading piece (a card's title over its
 * host, a group header's name before its count); the whole text when it is one piece.
 */
export function leadingTextOf(el: Element): string {
  return visiblePiecesOf(el)[0] ?? ''
}

function describe(el: Element): string {
  let where = el.tagName.toLowerCase()
  const role = el.getAttribute('role')
  if (role) where += `[role=${role}]`
  const classes = [...el.classList].filter((c) => c.startsWith('zen-')).slice(0, 2)
  if (classes.length) where += `.${classes.join('.')}`
  for (const attr of el.getAttributeNames()) {
    if (attr.startsWith('data-') && attr !== 'data-glyph' && attr !== 'data-surface') {
      where += `[${attr}${el.getAttribute(attr) ? `=${el.getAttribute(attr)}` : ''}]`
    }
  }
  return where
}

/**
 * Every exposed control under `root` whose name falls short of the rule: unnamed (a glyph alone
 * with no name), or named otherwise than the text it leads with ([leadingTextOf],
 * [nameCarries]). Disabled controls are read too: Switch Access scans them, and a name that
 * lies about them lies the same.
 */
export function auditNames(root: ParentNode): NameFinding[] {
  const findings: NameFinding[] = []
  for (const el of root.querySelectorAll(CONTROL_SELECTOR)) {
    if (!exposed(el)) continue
    const name = accessibleNameOf(el)
    const visible = visibleTextOf(el)
    if (!name) {
      findings.push({ where: describe(el), name, visible, issue: 'unnamed' })
      continue
    }
    if (!nameCarries(name, leadingTextOf(el))) {
      findings.push({ where: describe(el), name, visible, issue: 'mismatch' })
    }
  }
  return findings
}

/** The findings as lines for a failure message. */
export function formatNameFindings(findings: NameFinding[]): string {
  return findings
    .map((f) =>
      f.issue === 'unnamed'
        ? `${f.where}: no accessible name (shows '${f.visible}')`
        : `${f.where}: named '${f.name}', shows '${f.visible}'`
    )
    .join('\n')
}
