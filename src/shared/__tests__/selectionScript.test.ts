// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import {
  SELECTION_REPORT_DEBOUNCE_MS,
  SELECTION_REPORT_MAX_CHARS,
  currentSelectionReport,
  installSelectionReporter,
  type SelectionReport
} from '../selectionScript'

/*
 * The page's word on its selection (CT-39, `shared/selectionScript`): one report per settled
 * selection, one empty report when a reported selection goes or should stop showing, nothing
 * while nothing is selected. The mini menu in the chrome is drawn from these.
 */

const settle = (ms = SELECTION_REPORT_DEBOUNCE_MS + 30): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

let uninstall: (() => void) | null = null

afterEach(() => {
  uninstall?.()
  uninstall = null
  document.body.innerHTML = ''
  window.getSelection()?.removeAllRanges()
})

function install(): SelectionReport[] {
  const sent: SelectionReport[] = []
  uninstall = installSelectionReporter({ send: (report) => sent.push(report) })
  return sent
}

/** Select the text of `id` and fire the events the engine would: `selectionchange`, then the pointer's up. */
function selectAll(id: string, opts: { up?: boolean } = {}): void {
  const el = document.getElementById(id)!
  const range = document.createRange()
  range.selectNodeContents(el)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  if (opts.up !== false) window.dispatchEvent(new MouseEvent('mouseup'))
}

function collapse(): void {
  window.getSelection()!.removeAllRanges()
  document.dispatchEvent(new Event('selectionchange'))
}

describe('currentSelectionReport', () => {
  it('is null with nothing selected, and folds the selected text with its box', () => {
    document.body.innerHTML = '<p id="p">quantum\n   foam   theory</p>'
    expect(currentSelectionReport(document)).toBeNull()
    selectAll('p', { up: false })
    const report = currentSelectionReport(document)!
    expect(report.text).toBe('quantum foam theory')
    expect(report.isEditable).toBe(false)
    expect(report.rect).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })

  it('cuts a long selection at the cap', () => {
    document.body.innerHTML = `<p id="p">${'word '.repeat(400)}</p>`
    selectAll('p', { up: false })
    expect(currentSelectionReport(document)!.text).toHaveLength(SELECTION_REPORT_MAX_CHARS)
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
    selectAll('rich', { up: false })
    expect(currentSelectionReport(document)!.isEditable).toBe(true)
  })
})

describe('installSelectionReporter', () => {
  it('sends one report once the pointer has settled on a selection, and nothing while nothing is selected', async () => {
    document.body.innerHTML = '<p id="p">quantum foam</p>'
    const sent = install()
    // Caret moves and clicks fire selectionchange with nothing selected: no report.
    document.dispatchEvent(new Event('selectionchange'))
    window.dispatchEvent(new MouseEvent('mouseup'))
    await settle()
    expect(sent).toEqual([])
    selectAll('p')
    expect(sent).toEqual([])
    await settle()
    expect(sent).toEqual([
      { text: 'quantum foam', rect: { x: 0, y: 0, width: 0, height: 0 }, isEditable: false }
    ])
  })

  it('holds the report while the pointer is down and sends it after the up', async () => {
    document.body.innerHTML = '<p id="p">quantum foam</p>'
    const sent = install()
    window.dispatchEvent(new MouseEvent('mousedown'))
    selectAll('p', { up: false })
    await settle()
    expect(sent).toEqual([])
    window.dispatchEvent(new MouseEvent('mouseup'))
    await settle()
    expect(sent.map((r) => r.text)).toEqual(['quantum foam'])
  })

  it('sends one empty report when a reported selection collapses, and none when nothing was reported', async () => {
    document.body.innerHTML = '<p id="p">quantum foam</p>'
    const sent = install()
    selectAll('p')
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
    selectAll('p')
    collapse()
    await settle()
    expect(sent).toEqual([])
  })

  it('reports the keyboard\u2019s selection after the key comes up', async () => {
    document.body.innerHTML = '<p id="p">quantum foam</p>'
    const sent = install()
    selectAll('p', { up: false })
    await settle()
    expect(sent.map((r) => r.text)).toEqual(['quantum foam'])
    // Growing it with shift+arrow: another settled report, one per settle.
    document.dispatchEvent(new Event('selectionchange'))
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight' }))
    await settle()
    expect(sent.map((r) => r.text)).toEqual(['quantum foam', 'quantum foam'])
  })

  it('hides on the pointer going down and shows again after the up', async () => {
    document.body.innerHTML = '<p id="p">quantum foam</p>'
    const sent = install()
    selectAll('p')
    await settle()
    window.dispatchEvent(new MouseEvent('mousedown'))
    expect(sent.map((r) => r.text)).toEqual(['quantum foam', ''])
    window.dispatchEvent(new MouseEvent('mouseup'))
    await settle()
    expect(sent.map((r) => r.text)).toEqual(['quantum foam', '', 'quantum foam'])
  })

  it('hides through a scroll and reports the selection again once the scroll settles', async () => {
    document.body.innerHTML = '<p id="p">quantum foam</p>'
    const sent = install()
    selectAll('p')
    await settle()
    window.dispatchEvent(new Event('scroll'))
    window.dispatchEvent(new Event('scroll'))
    window.dispatchEvent(new Event('scroll'))
    expect(sent.map((r) => r.text)).toEqual(['quantum foam', ''])
    await settle()
    expect(sent.map((r) => r.text)).toEqual(['quantum foam', '', 'quantum foam'])
  })

  it('reads nothing on a scroll while nothing is selected', async () => {
    document.body.innerHTML = '<p id="p">quantum foam</p>'
    const sent = install()
    window.dispatchEvent(new Event('scroll'))
    window.dispatchEvent(new Event('resize'))
    await settle()
    expect(sent).toEqual([])
  })

  it('leaves a standing selection alone when the page loses the keyboard, and hides when the document is hidden', async () => {
    document.body.innerHTML = '<p id="p">quantum foam</p>'
    const sent = install()
    selectAll('p')
    await settle()
    window.dispatchEvent(new Event('blur'))
    expect(sent.map((r) => r.text)).toEqual(['quantum foam'])
    window.dispatchEvent(new Event('pagehide'))
    expect(sent.map((r) => r.text)).toEqual(['quantum foam', ''])
  })

  it("reports a text field's selection as editable", async () => {
    document.body.innerHTML = '<input id="f" value="hello world">'
    const sent = install()
    const field = document.getElementById('f') as HTMLInputElement
    field.focus()
    field.setSelectionRange(6, 11)
    document.dispatchEvent(new Event('selectionchange'))
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift' }))
    await settle()
    expect(sent).toEqual([
      { text: 'world', rect: { x: 0, y: 0, width: 0, height: 0 }, isEditable: true }
    ])
  })

  it('sends nothing after the uninstall', async () => {
    document.body.innerHTML = '<p id="p">quantum foam</p>'
    const sent = install()
    selectAll('p')
    uninstall!()
    uninstall = null
    await settle()
    expect(sent).toEqual([])
  })
})
