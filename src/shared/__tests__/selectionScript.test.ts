// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SELECTION_REPORT_DEBOUNCE_MS,
  SELECTION_REPORT_MAX_CHARS,
  currentSelectionReport,
  installSelectionReporter,
  type SelectionReport
} from '../selectionScript'

/*
 * The page's word on its selection (CT-39, `shared/selectionScript`): one report per selection
 * a gesture made or changed, once it settles; one empty report when a reported selection goes or
 * should stop showing; nothing while nothing is selected and nothing for a selection no gesture
 * of this document's made – a script's, a find match's, one merely persisting through an
 * unrelated click or key (the gesture rule, the module's note). The mini menu in the chrome is
 * drawn from these.
 */

const settle = (ms = SELECTION_REPORT_DEBOUNCE_MS + 30): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

let uninstall: (() => void) | null = null

afterEach(() => {
  uninstall?.()
  uninstall = null
  document.body.innerHTML = ''
  window.getSelection()?.removeAllRanges()
  vi.restoreAllMocks()
})

function install(): SelectionReport[] {
  const sent: SelectionReport[] = []
  uninstall = installSelectionReporter({ send: (report) => sent.push(report) })
  return sent
}

const down = (): void => void window.dispatchEvent(new MouseEvent('mousedown'))
const up = (): void => void window.dispatchEvent(new MouseEvent('mouseup'))
const keyDown = (key: string): void =>
  void window.dispatchEvent(new KeyboardEvent('keydown', { key }))
const keyUp = (key: string): void => void window.dispatchEvent(new KeyboardEvent('keyup', { key }))
/** A caret's move: `selectionchange` with nothing selected (a text field's selection fires it too). */
const selectionChanged = (): void => void document.dispatchEvent(new Event('selectionchange'))

/*
 * happy-dom fires `selectionchange` synchronously on each change of the selection's range – the
 * `removeAllRanges` of a two-step replacement is seen as a collapse – where Chromium coalesces
 * the changes of one task into one asynchronous event. The reporter reads the selection fresh at
 * each, so both engines see the same reports for the same standing selection.
 */

/** Select the contents of `id` as a script would (`removeAllRanges` + `addRange`): no gesture. */
function scriptSelect(id: string): void {
  const el = document.getElementById(id)!
  const range = document.createRange()
  range.selectNodeContents(el)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

/** Select `from`..`to` of `id`'s text node in one step, as the engine's default action for a key or a drag would. */
function selectChars(id: string, from: number, to: number): void {
  const text = document.getElementById(id)!.firstChild!
  window.getSelection()!.setBaseAndExtent(text, from, text, to)
}

/** Select the contents of `id` by a drag: the pointer down, the selection made as it moves, the up. */
function dragSelect(id: string): void {
  down()
  scriptSelect(id)
  up()
}

function collapse(): void {
  window.getSelection()!.removeAllRanges()
}

/** A range's box is as wide as its text: the extended selection's box is telling. */
function boxesByText(): void {
  vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(function (this: Range) {
    const width = this.toString().length * 8
    return { left: 4, top: 20, width, height: 16, x: 4, y: 20, right: 4 + width, bottom: 36 }
  } as () => DOMRect)
}

describe('currentSelectionReport', () => {
  it('is null with nothing selected, and folds the selected text with its box', () => {
    document.body.innerHTML = '<p id="p">quantum\n   foam   theory</p>'
    expect(currentSelectionReport(document)).toBeNull()
    scriptSelect('p')
    const report = currentSelectionReport(document)!
    expect(report.text).toBe('quantum foam theory')
    expect(report.isEditable).toBe(false)
    expect(report.rect).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })

  it('cuts a long selection at the cap, folded whitespace and all', () => {
    document.body.innerHTML = `<p id="p">${'word '.repeat(400)}</p>`
    scriptSelect('p')
    expect(currentSelectionReport(document)!.text).toHaveLength(SELECTION_REPORT_MAX_CHARS)
    // Runs of whitespace fold before the cap counts: the cap is of folded characters.
    document.body.innerHTML = `<p id="p">${'w   '.repeat(1000)}</p>`
    scriptSelect('p')
    const folded = currentSelectionReport(document)!.text
    expect(folded).toHaveLength(SELECTION_REPORT_MAX_CHARS)
    expect(folded).not.toMatch(/\s\s/)
  })

  it("reads a text field's own selection as editable, and a password field's as nothing", () => {
    document.body.innerHTML =
      '<input id="f" value="hello world"><input id="pw" type="password" value="secret">'
    const field = document.getElementById('f') as HTMLInputElement
    field.focus()
    field.setSelectionRange(0, 5)
    expect(currentSelectionReport(document)).toEqual({
      text: 'hello',
      rect: { x: 0, y: 0, width: 0, height: 0 },
      isEditable: true
    })
    field.setSelectionRange(3, 3)
    expect(currentSelectionReport(document)).toBeNull()
    const pw = document.getElementById('pw') as HTMLInputElement
    pw.focus()
    pw.setSelectionRange(0, 6)
    expect(currentSelectionReport(document)).toBeNull()
  })

  it('flags a selection inside editable content', () => {
    document.body.innerHTML = '<div id="rich" contenteditable="true">draft text</div>'
    scriptSelect('rich')
    expect(currentSelectionReport(document)!.isEditable).toBe(true)
  })
})

describe('installSelectionReporter', () => {
  it('sends one report once a drag has settled on the selection it made, and nothing while nothing is selected', async () => {
    document.body.innerHTML = '<p id="p">quantum foam</p>'
    const sent = install()
    // Caret moves and clicks fire selectionchange with nothing selected: no report.
    down()
    selectionChanged()
    up()
    await settle()
    expect(sent).toEqual([])
    dragSelect('p')
    expect(sent).toEqual([])
    await settle()
    expect(sent).toEqual([
      { text: 'quantum foam', rect: { x: 0, y: 0, width: 0, height: 0 }, isEditable: false }
    ])
  })

  it('holds the report while the pointer is down and sends it after the up', async () => {
    document.body.innerHTML = '<p id="p">quantum foam</p>'
    const sent = install()
    down()
    scriptSelect('p')
    await settle()
    expect(sent).toEqual([])
    up()
    await settle()
    expect(sent.map((r) => r.text)).toEqual(['quantum foam'])
  })

  it('sends one empty report when a reported selection collapses, and none when nothing was reported', async () => {
    document.body.innerHTML = '<p id="p">quantum foam</p>'
    const sent = install()
    dragSelect('p')
    await settle()
    collapse()
    collapse()
    await settle()
    expect(sent.map((r) => r.text)).toEqual(['quantum foam', ''])
    expect(sent[1]).toEqual({ text: '', rect: null, isEditable: false })
  })

  it('sends nothing for a selection that collapsed before it settled', async () => {
    document.body.innerHTML = '<p id="p">quantum foam</p>'
    const sent = install()
    dragSelect('p')
    collapse()
    await settle()
    expect(sent).toEqual([])
  })

  describe('the gesture rule', () => {
    it('raises nothing for a selection a script made, however the script goes on changing it', async () => {
      document.body.innerHTML = '<p id="p">quantum foam</p><p id="q">other text</p>'
      const sent = install()
      scriptSelect('p')
      await settle()
      expect(sent).toEqual([])
      scriptSelect('q')
      window.getSelection()!.selectAllChildren(document.body)
      await settle()
      expect(sent).toEqual([])
    })

    it('raises nothing when the same selection merely persists through a key or a click that changes nothing', async () => {
      document.body.innerHTML = '<p id="p">quantum foam</p>'
      const sent = install()
      scriptSelect('p')
      keyDown('Control')
      keyUp('Control')
      await settle()
      expect(sent).toEqual([])
      down()
      up()
      await settle()
      expect(sent).toEqual([])
    })

    it("raises the keyboard's extension of a standing selection, with the extended box", async () => {
      document.body.innerHTML = '<p id="p">quantum foam theory</p>'
      boxesByText()
      const sent = install()
      selectChars('p', 0, 7)
      await settle()
      expect(sent).toEqual([])
      // Shift+ArrowRight: the key goes down, the engine extends the selection, the key comes up.
      keyDown('Shift')
      keyDown('ArrowRight')
      selectChars('p', 0, 12)
      keyUp('ArrowRight')
      expect(sent).toEqual([])
      await settle()
      expect(sent).toEqual([
        { text: 'quantum foam', rect: { x: 4, y: 20, width: 96, height: 16 }, isEditable: false }
      ])
      keyUp('Shift')
      await settle()
      expect(sent).toHaveLength(1)
    })

    it('clears the menu as a click collapses the standing selection', async () => {
      document.body.innerHTML = '<p id="p">quantum foam</p>'
      const sent = install()
      dragSelect('p')
      await settle()
      expect(sent.map((r) => r.text)).toEqual(['quantum foam'])
      down()
      expect(sent.map((r) => r.text)).toEqual(['quantum foam', ''])
      collapse()
      up()
      await settle()
      expect(sent.map((r) => r.text)).toEqual(['quantum foam', ''])
    })

    it("follows a script's change to a standing gesture-made selection with the fresh report, no raise and no drop between", async () => {
      document.body.innerHTML = '<p id="p">quantum foam</p><p id="q">other text</p>'
      const sent = install()
      dragSelect('p')
      await settle()
      expect(sent.map((r) => r.text)).toEqual(['quantum foam'])
      // The script moves the standing selection in one step: the menu follows it.
      selectChars('q', 0, 5)
      await settle()
      expect(sent.map((r) => r.text)).toEqual(['quantum foam', 'other'])
      // A script that empties the selection before selecting anew has collapsed it: the menu
      // goes at once, and what the script selects next is a script's – no menu.
      scriptSelect('p')
      expect(sent.map((r) => r.text)).toEqual(['quantum foam', 'other', ''])
      await settle()
      expect(sent).toHaveLength(3)
    })

    it('raises nothing for an up whose down this document never saw', async () => {
      document.body.innerHTML = '<p id="p">quantum foam</p>'
      const sent = install()
      // The find bar's match: the chrome selected it, and its Escape's up lands here.
      scriptSelect('p')
      keyUp('Escape')
      up()
      await settle()
      expect(sent).toEqual([])
    })

    it('ends a press begun here when the keyboard leaves the page, so a later up is no gesture', async () => {
      document.body.innerHTML = '<p id="p">quantum foam</p>'
      const sent = install()
      keyDown('f')
      window.dispatchEvent(new Event('blur'))
      scriptSelect('p')
      keyUp('f')
      await settle()
      expect(sent).toEqual([])
    })

    it('hides on the pointer going down, and comes back only over a selection the up changed', async () => {
      document.body.innerHTML = '<p id="p">quantum foam</p><p id="q">other text</p>'
      const sent = install()
      dragSelect('p')
      await settle()
      down()
      expect(sent.map((r) => r.text)).toEqual(['quantum foam', ''])
      up()
      await settle()
      expect(sent.map((r) => r.text)).toEqual(['quantum foam', ''])
      dragSelect('q')
      await settle()
      expect(sent.map((r) => r.text)).toEqual(['quantum foam', '', 'other text'])
    })
  })

  it('hides through a scroll and reports the selection again once the scroll settles', async () => {
    document.body.innerHTML = '<p id="p">quantum foam</p>'
    const sent = install()
    dragSelect('p')
    await settle()
    window.dispatchEvent(new Event('scroll'))
    window.dispatchEvent(new Event('scroll'))
    window.dispatchEvent(new Event('scroll'))
    expect(sent.map((r) => r.text)).toEqual(['quantum foam', ''])
    await settle()
    expect(sent.map((r) => r.text)).toEqual(['quantum foam', '', 'quantum foam'])
  })

  it("reads nothing on a scroll while nothing is selected, or while only a script's selection stands", async () => {
    document.body.innerHTML = '<p id="p">quantum foam</p>'
    const sent = install()
    window.dispatchEvent(new Event('scroll'))
    window.dispatchEvent(new Event('resize'))
    await settle()
    scriptSelect('p')
    window.dispatchEvent(new Event('scroll'))
    await settle()
    expect(sent).toEqual([])
  })

  it('leaves a standing selection alone when the page loses the keyboard, and hides when the document is hidden', async () => {
    document.body.innerHTML = '<p id="p">quantum foam</p>'
    const sent = install()
    dragSelect('p')
    await settle()
    window.dispatchEvent(new Event('blur'))
    expect(sent.map((r) => r.text)).toEqual(['quantum foam'])
    window.dispatchEvent(new Event('pagehide'))
    expect(sent.map((r) => r.text)).toEqual(['quantum foam', ''])
  })

  it("reports a text field's selection the keyboard made as editable", async () => {
    document.body.innerHTML = '<input id="f" value="hello world">'
    const sent = install()
    const field = document.getElementById('f') as HTMLInputElement
    field.focus()
    keyDown('Shift')
    keyDown('End')
    field.setSelectionRange(6, 11)
    selectionChanged()
    keyUp('End')
    await settle()
    expect(sent).toEqual([
      { text: 'world', rect: { x: 0, y: 0, width: 0, height: 0 }, isEditable: true }
    ])
  })

  it('sends nothing after the uninstall', async () => {
    document.body.innerHTML = '<p id="p">quantum foam</p>'
    const sent = install()
    dragSelect('p')
    uninstall!()
    uninstall = null
    await settle()
    expect(sent).toEqual([])
  })
})
