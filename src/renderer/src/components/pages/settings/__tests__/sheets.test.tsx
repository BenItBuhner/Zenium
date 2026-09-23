// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { viewportStore } from '@renderer/lib/formFactor'
import { FrameDialogHost } from '@renderer/lib/portals'
import { SheetFooter } from '../blocks'
import type { ActionRow, DetailRow, FieldRow, ItemRow, RowGroup, ValueRow } from '../model'
import { SheetStack } from '../sheets'

/*
 * The phone Settings sheets (sheets.tsx) under a finger. They mount through the frame's dialog
 * host on the sheet chassis (`FrameDialogHost` on a phone, lib/portals.tsx), each drawing its
 * own scrim (`ownScrim`), so the host's chassis stays down for them and never raises
 * `data-sheet-up` – and main.css cuts the pointer from every slot child that is not a layer on
 * the chassis (`[data-sheet-layer]`) while the host is not up. `pointer-events` is inherited: a
 * wrapper without the mark makes the whole sheet transparent to a tap, which falls through the
 * slot to the host's scrim, the dismissal. A click dispatched to the option itself (an
 * accessibility click, the keyboard) never meets the cut, so the shipped stylesheet is loaded
 * here and the finger's target is found the way the browser's hit test finds it. Rendered for
 * real in happy-dom, the frame loop cranked by hand, the layout given sizes.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** A hand-cranked animation frame: `run(n)` advances the clock 16 ms a frame and runs the callbacks. */
class Frames {
  now = 0
  private queue = new Map<number, (now: number) => void>()
  private seq = 0

  install(): void {
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
      const id = ++this.seq
      this.queue.set(id, cb)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      this.queue.delete(id)
    })
    vi.stubGlobal('performance', { now: () => this.now })
  }

  run(n: number): void {
    for (let i = 0; i < n; i++) {
      this.now += 16
      const pending = [...this.queue.values()]
      this.queue.clear()
      for (const cb of pending) cb(this.now)
    }
  }

  get scheduled(): boolean {
    return this.queue.size > 0
  }
}

const frames = new Frames()
let root: Root | null = null
let mount: HTMLElement | null = null
let sizes: Array<[string, PropertyDescriptor | undefined]> = []

function render(el: ReactElement): void {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(el))
}

/** Let the wait for the page's cover resolve (at once with no page) and the sheet come up. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

/** Run the sheet's spring to rest: a finger landing on a moving sheet catches it, never taps. */
function rest(): void {
  for (let i = 0; i < 200 && frames.scheduled; i++) act(() => frames.run(1))
  expect(frames.scheduled).toBe(false)
}

/**
 * The chrome's stylesheet as shipped, in the form happy-dom takes: comments and the Tailwind
 * directives out, whitespace folded (prettier breaks a long selector over several lines) and
 * every `@layer` block unwrapped, since happy-dom reads no rule inside an at-rule it does not
 * know. The rules themselves are untouched.
 */
function shippedStylesheet(): string {
  const css = readFileSync(resolve(__dirname, '../../../../assets/main.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@(import|source|custom-variant)\b[^;]*;/g, '')
    .replace(/\s+/g, ' ')
  let out = ''
  /** For every open brace, whether it is a `@layer` block's (dropped with its closing brace). */
  const layers: boolean[] = []
  for (let i = 0; i < css.length; i++) {
    const header = /^@layer\b[^{;]*\{/.exec(css.slice(i, i + 64))
    if (header) {
      layers.push(true)
      i += header[0].length - 1
      continue
    }
    const ch = css[i]
    if (ch === '{') layers.push(false)
    if (ch === '}' && layers.pop()) continue
    out += ch
  }
  return out
}

const host = (): HTMLElement => mount!.querySelector<HTMLElement>('.zen-frame-dialogs')!
const hostScrim = (): HTMLElement => host().querySelector<HTMLElement>('.zen-frame-scrim')!
/** The slot's child for the (first) sheet: `BottomSheet`'s own layer, which `PhoneSheet` returns to the slot. */
const wrapper = (): HTMLElement =>
  mount!.querySelector<HTMLElement>('.zen-frame-dialogs-slot > [data-sheet-layer]')!
const options = (): HTMLElement[] => [...mount!.querySelectorAll<HTMLElement>('[role="radio"]')]

/**
 * `pointer-events` as the browser resolves it for an element: its own cascaded value, else –
 * an inherited property – its parent's (happy-dom cascades the stylesheet, inline style and
 * specificity included, but inherits only a fixed list of properties, this one not among them).
 */
function pointerEvents(el: Element): string {
  const own = getComputedStyle(el).getPropertyValue('pointer-events')
  if (own !== '' && own !== 'inherit') return own
  return el.parentElement ? pointerEvents(el.parentElement) : 'auto'
}

/**
 * What a finger landing on `el` reaches, as the browser's hit test finds it with every layer
 * here filling the host's box: `el` itself unless `pointer-events: none` – its own or inherited –
 * lets the press through, then the nearest ancestor that takes it; and past the slot, which
 * takes none, the host's scrim, painted under the slot across the same box.
 */
function underFinger(el: HTMLElement): HTMLElement {
  let node: HTMLElement | null = el
  while (node) {
    if (pointerEvents(node) !== 'none') return node
    node = node.classList.contains('zen-frame-dialogs-slot') ? hostScrim() : node.parentElement
  }
  throw new Error('nothing under the finger')
}

/** A finger's tap on `el`: down, up and the click that follows, on whatever is under it. */
function tap(el: HTMLElement): HTMLElement {
  const target = underFinger(el)
  act(() => {
    for (const type of ['pointerdown', 'pointerup']) {
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          pointerId: 1,
          pointerType: 'touch',
          isPrimary: true
        })
      )
    }
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
  })
  return target
}

/** A §9.13 value row and the picker sheet's request for it. */
function groups(onChange: (value: string) => void): RowGroup[] {
  const row: ValueRow = {
    kind: 'value',
    id: 'engine',
    label: 'Search engine',
    value: 'google',
    options: [
      { value: 'google', label: 'Google' },
      { value: 'duckduckgo', label: 'DuckDuckGo' }
    ],
    onChange
  }
  return [{ id: 'search', heading: 'Search', rows: [row] }]
}

let stylesheet: HTMLStyleElement | null = null

beforeAll(() => {
  stylesheet = document.createElement('style')
  stylesheet.textContent = shippedStylesheet()
  document.head.appendChild(stylesheet)
})

afterAll(() => {
  stylesheet?.remove()
  stylesheet = null
})

beforeEach(() => {
  frames.install()
  viewportStore.set({ ...viewportStore.get(), formFactor: 'phone' })
  sizes = ['clientHeight', 'offsetHeight'].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
  ])
  // The layer is 800 px tall and the sheet's content 300 px: a sheet with room to stand.
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('zen-sheet-scroll') ? 300 : 800
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 300
  })
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
  act(() => viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop' }))
  vi.unstubAllGlobals()
  frames.now = 0
  for (const [name, descriptor] of sizes) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
  }
})

describe('a hosted Settings sheet under a finger', () => {
  it('a tap on a picker option reaches the option, not the scrim under the sheet', async () => {
    const onChange = vi.fn()
    render(
      <FrameDialogHost>
        <SheetStack
          requests={[{ kind: 'options', rowId: 'engine' }]}
          groups={groups(onChange)}
          ctx={{ open: () => undefined }}
          closeTop={() => undefined}
        />
      </FrameDialogHost>
    )
    await settle()
    rest()
    const [, duckduckgo] = options()
    expect(duckduckgo).toBeDefined()
    // The sheet is a layer on the chassis already: the host's own stays down for it.
    expect(host().getAttribute('data-sheet')).toBe('true')
    expect(host().getAttribute('data-open')).toBe('true')
    expect(host().hasAttribute('data-sheet-up')).toBe(false)
    // So the slot's child – the chassis's own layer, nothing of the Settings tab's around it –
    // says so, or the cut for the slot's other children takes the pointer from the whole sheet,
    // and the finger finds the host's scrim instead.
    const layer = wrapper()
    expect(layer.classList.contains('zen-settings-sheet-layer')).toBe(false)
    expect(layer.querySelector('.zen-sheet.zen-settings-sheet')).not.toBeNull()
    expect(underFinger(duckduckgo!)).toBe(duckduckgo)
    layer.removeAttribute('data-sheet-layer')
    expect(pointerEvents(layer)).toBe('none')
    expect(underFinger(duckduckgo!)).toBe(hostScrim())
    layer.setAttribute('data-sheet-layer', 'true')
    expect(pointerEvents(layer)).toBe('auto')

    expect(tap(duckduckgo!)).toBe(duckduckgo)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('duckduckgo')
  })

  it('a detail row’s sheet stands over the item sheet that holds it (§9.24 depth two)', async () => {
    const onClear = vi.fn()
    const open = vi.fn()
    const detail: DetailRow = {
      kind: 'detail',
      id: 'ext:errors',
      label: 'Errors',
      summary: '1 error',
      sheet: {
        title: 'Errors',
        description: 'Dark Reader',
        groups: [
          {
            id: 'ext-errors',
            heading: null,
            rows: [
              {
                kind: 'info',
                id: 'ext:error:1',
                label: 'Uncaught TypeError',
                description: 'Service worker · 5 min ago',
                clamp: true
              }
            ],
            empty: 'No errors'
          },
          {
            id: 'ext-errors-clear',
            heading: null,
            rows: [
              {
                kind: 'action',
                id: 'ext:clear-errors',
                label: 'Clear errors',
                destructive: true,
                onPress: onClear
              }
            ]
          }
        ]
      }
    }
    const item: ItemRow = {
      kind: 'item',
      id: 'ext',
      label: 'Dark Reader',
      sheet: {
        title: 'Dark Reader',
        description: 'manifest_version: Required key is missing',
        descriptionTone: 'danger',
        groups: [{ id: 'ext-controls', heading: null, rows: [detail] }]
      }
    }
    render(
      <FrameDialogHost>
        <SheetStack
          requests={[
            { kind: 'item', rowId: 'ext' },
            { kind: 'detail', rowId: 'ext:errors' }
          ]}
          groups={[{ id: 'extensions', heading: 'Extensions', rows: [item] }]}
          ctx={{ open }}
          closeTop={() => undefined}
        />
      </FrameDialogHost>
    )
    await settle()
    rest()
    // Two layers on the chassis, lowest first: the details sheet, then the console over it,
    // each on a §9.23 title block (both carry a description), the shared `PhoneSheet`'s.
    const layers = [
      ...mount!.querySelectorAll<HTMLElement>('.zen-frame-dialogs-slot > [data-sheet-layer]')
    ]
    expect(layers).toHaveLength(2)
    const titles = layers.map((l) => l.querySelector('.zen-sheet-title-block h2')?.textContent)
    expect(titles).toEqual(['Dark Reader', 'Errors'])
    // The details sheet's description is the load error, in the danger ink; the console's is
    // the extension's name, plain.
    const descriptions = layers.map((l) => l.querySelector('.zen-sheet-title-block p'))
    expect(descriptions[0]?.textContent).toBe('manifest_version: Required key is missing')
    expect(descriptions[0]?.getAttribute('data-tone')).toBe('danger')
    expect(descriptions[1]?.textContent).toBe('Dark Reader')
    expect(descriptions[1]?.hasAttribute('data-tone')).toBe(false)
    // The detail row in the lower sheet, drawn with its summary; the console's rows in the upper.
    const detailRow = layers[0]!.querySelector<HTMLElement>('[data-row="ext:errors"]')
    expect(detailRow?.querySelector('.zen-settings-summary')?.textContent).toBe('1 error')
    expect(layers[1]!.querySelector('[data-row="ext:error:1"]')).not.toBeNull()
    const clear = layers[1]!.querySelector<HTMLElement>('[data-row="ext:clear-errors"]')
    expect(clear).not.toBeNull()
    expect(clear!.classList.contains('zen-settings-row-danger')).toBe(true)
    // Nothing opens over depth two: Clear errors is a plain action, no confirm request.
    expect(tap(clear!)).toBe(clear)
    expect(onClear).toHaveBeenCalledTimes(1)
    expect(open).not.toHaveBeenCalled()
  })
})

/*
 * The footer slot's measure (#322's review, Required 3): the chassis draws the footer element
 * on `SheetFooter`'s claim and the portal fills it a render later, so the detents the sheet
 * takes on the claim are measured over an empty footer and come out short by the buttons – the
 * viewer's empty line clipped to a sliver under Clear all. The sheet has to ask for its detents
 * again once the footer has its content.
 */
describe('a Settings sheet whose form claims the footer', () => {
  /** A form whose only content is a line and the footer it claims, as the site-data viewer's was. */
  function formGroups(): RowGroup[] {
    const row: ActionRow = {
      kind: 'action',
      id: 'viewer',
      label: 'See all site data',
      form: {
        title: 'Site data',
        render: () => (
          <div className="zen-settings-sheet-rows">
            <p className="zen-settings-empty">No site has stored data</p>
            <SheetFooter>
              <button type="button">Clear all</button>
            </SheetFooter>
          </div>
        )
      }
    }
    return [{ id: 'site-data', heading: null, rows: [row] }]
  }

  /** The stack with the form's sheet open. */
  function renderForm(): void {
    render(
      <FrameDialogHost>
        <SheetStack
          requests={[{ kind: 'form', rowId: 'viewer' }]}
          groups={formGroups()}
          ctx={{ open: () => undefined }}
          closeTop={() => undefined}
        />
      </FrameDialogHost>
    )
  }

  /**
   * Counts the sheet's detent measures – `BottomSheet.measure` lets the sheet size itself
   * (`height: auto`) for one read of its `offsetHeight` – and gives the footer element the
   * height the test says it has.
   */
  function measureCounter(): { measures(): number; footer: { height: number } } {
    let measures = 0
    const footer = { height: 0 }
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        if (this.classList.contains('zen-sheet') && this.style.height === 'auto') measures++
        if (this.classList.contains('zen-settings-sheet-footer')) return footer.height
        return 300
      }
    })
    return { measures: () => measures, footer }
  }

  it('watches the footer element and measures again when its content has filled it', async () => {
    const observers: FakeResizeObserver[] = []
    class FakeResizeObserver {
      targets: Element[] = []
      disconnected = false
      constructor(private readonly callback: () => void) {
        observers.push(this)
      }
      observe(target: Element): void {
        this.targets.push(target)
      }
      disconnect(): void {
        this.disconnected = true
      }
      fire(): void {
        this.callback()
      }
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    const counter = measureCounter()
    renderForm()
    await settle()
    rest()
    const footer = mount!.querySelector<HTMLElement>('[data-testid="settings-sheet-footer"]')
    expect(footer).not.toBeNull()
    // The portal has filled the footer the chassis drew on the claim.
    expect(footer!.querySelector('button')?.textContent).toBe('Clear all')
    // The footer element itself is what the sheet watches.
    const watcher = observers.find((o) => o.targets.includes(footer!))
    expect(watcher).toBeDefined()
    // It grows as the buttons land: the sheet takes its detents again …
    const before = counter.measures()
    counter.footer.height = 72
    act(() => watcher!.fire())
    expect(counter.measures()).toBeGreaterThan(before)
    // … and not for a report that changed nothing.
    const after = counter.measures()
    act(() => watcher!.fire())
    expect(counter.measures()).toBe(after)
    // Closing the sheet stops the watch.
    act(() => root!.unmount())
    root = null
    expect(watcher!.disconnected).toBe(true)
  })

  it('without a ResizeObserver, measures again one frame after the footer is drawn', async () => {
    vi.stubGlobal('ResizeObserver', undefined)
    const counter = measureCounter()
    renderForm()
    await settle()
    // The claim's measure has run over the empty footer; the frame's relayout is queued.
    const before = counter.measures()
    expect(frames.scheduled).toBe(true)
    rest()
    expect(counter.measures()).toBeGreaterThan(before)
  })
})

/*
 * Where the focus lands as a Settings sheet opens (§9.22): a confirmation is a title-and-notice
 * sheet, so it holds its container – named by the question, described by the paragraph – and
 * never Cancel, its first button (the failure the section names: the way out read first); a
 * field sheet, whose first control is a text field, holds its container too – the chassis's own
 * exception, the keyboard must not come up with the sheet; a picker opens on its checked option.
 */
describe('where a Settings sheet lands the focus (§9.22)', () => {
  function stack(requests: Parameters<typeof SheetStack>[0]['requests'], rows: RowGroup[]): void {
    render(
      <FrameDialogHost>
        <SheetStack
          requests={requests}
          groups={rows}
          ctx={{ open: () => undefined }}
          closeTop={() => undefined}
        />
      </FrameDialogHost>
    )
  }
  const sheetEl = (): HTMLElement => mount!.querySelector<HTMLElement>('.zen-sheet[role="dialog"]')!
  const buttons = (): string[] =>
    [...sheetEl().querySelectorAll<HTMLButtonElement>('.zen-settings-sheet-actions button')].map(
      (b) => b.textContent ?? ''
    )

  it('a confirmation holds its container, never Cancel', async () => {
    const onPress = vi.fn()
    const row: ActionRow = {
      kind: 'action',
      id: 'clear-data',
      label: 'Clear browsing data',
      destructive: true,
      confirm: {
        title: 'Clear browsing data?',
        description: 'History, cookies and site data go.',
        action: 'Clear'
      },
      onPress
    }
    stack([{ kind: 'confirm', rowId: row.id }], [{ id: 'privacy', heading: null, rows: [row] }])
    await settle()
    rest()
    const sheet = sheetEl()
    expect(buttons()).toEqual(['Cancel', 'Clear'])
    expect(document.activeElement).toBe(sheet)
    expect(sheet.getAttribute('tabindex')).toBe('-1')
    const block = sheet.querySelector<HTMLElement>('.zen-sheet-title-block')!
    expect(block.querySelector('h2')?.textContent).toBe('Clear browsing data?')
    expect(sheet.getAttribute('aria-labelledby')).toBe(block.querySelector('h2')!.id)
    expect(sheet.getAttribute('aria-describedby')).toBe(block.querySelector('p')!.id)
    expect(onPress).not.toHaveBeenCalled()
  })

  it('a field sheet holds its container: its text field never takes the focus on its own', async () => {
    const row: FieldRow = {
      kind: 'field',
      id: 'name',
      label: 'Device name',
      value: 'Pixel',
      input: 'text',
      onCommit: () => undefined
    }
    stack([{ kind: 'field', rowId: 'name' }], [{ id: 'sync', heading: null, rows: [row] }])
    await settle()
    rest()
    const sheet = sheetEl()
    const field = sheet.querySelector<HTMLInputElement>('input')
    expect(field).not.toBeNull()
    expect(document.activeElement).toBe(sheet)
    expect(document.activeElement).not.toBe(field)
  })

  it('a picker opens on its checked option', async () => {
    stack(
      [{ kind: 'options', rowId: 'engine' }],
      groups(() => undefined)
    )
    await settle()
    rest()
    const checked = options().find((o) => o.getAttribute('aria-checked') === 'true')
    expect(checked?.textContent).toBe('Google')
    expect(document.activeElement).toBe(checked)
  })
})
