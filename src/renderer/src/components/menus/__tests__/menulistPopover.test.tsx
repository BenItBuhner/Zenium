// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, useState, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { anchorOf, type Anchor } from '@renderer/lib/anchor'
import { MenulistPopover, type MenulistOption } from '../MenulistPopover'

/*
 * The one menulist popup (design language v2 §9.13, §9.20, §9.22; shell pass 7(b)), rendered
 * for real in happy-dom: a listbox in the chrome layer on the shared popup class, the current
 * option checked and focused as it opens, the action rows after a hairline, the trigger's width
 * riding in `--zen-anchor-width`; the arrows, Home, End and the letters (type-ahead) move the
 * cursor, Enter picks, Escape closes and gives the focus back to the trigger; a font picker's
 * rows keep their names in the chrome's type with an "Aa" specimen in the face trailing. Layout
 * is given sizes by hand (happy-dom lays nothing out).
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let mount: HTMLElement | null = null
const picked = vi.fn<(value: string) => void>()
const closed = vi.fn<() => void>()
const chose = vi.fn<() => void>()

const OPTIONS: MenulistOption<string>[] = [
  { value: 'da', label: 'Danish' },
  { value: 'nl', label: 'Dutch' },
  { value: 'en', label: 'English', description: 'Downloaded · 42 MB' },
  { value: 'et', label: 'Estonian' },
  { value: 'fr', label: 'French' }
]

function Host({
  value = 'en',
  withAction = false,
  options = OPTIONS,
  className
}: {
  value?: string | null
  withAction?: boolean
  options?: MenulistOption<string>[]
  className?: string
}): JSX.Element {
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  return (
    <>
      <button
        type="button"
        className="zen-v2-menulist"
        aria-label="Language"
        aria-expanded={anchor !== null || undefined}
        onClick={(e) => setAnchor(anchorOf(e.currentTarget))}
      >
        English
      </button>
      {anchor && (
        <MenulistPopover
          anchor={anchor}
          label="Language"
          value={value}
          options={options}
          className={className}
          actions={withAction ? [{ label: 'Choose another…', onPick: chose }] : undefined}
          onPick={(next) => {
            setAnchor(null)
            picked(next)
          }}
          onClose={() => {
            setAnchor(null)
            closed()
          }}
        />
      )}
    </>
  )
}

function render(
  props: {
    value?: string | null
    withAction?: boolean
    options?: MenulistOption<string>[]
    className?: string
  } = {}
): void {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(<Host {...props} />))
}

const trigger = (): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>('.zen-v2-menulist')!
const list = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="listbox"]')
const rows = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')
]
const key = (
  k: string,
  target: Element = document.activeElement ?? document.body,
  init: KeyboardEventInit = {}
): void => {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })
    )
  })
}
const click = (el: Element): void => {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}
function open(): void {
  act(() => trigger().focus())
  click(trigger())
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => 200
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 152
  })
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const trigger = this.classList.contains('zen-v2-menulist')
    return {
      x: 100,
      y: 300,
      left: 100,
      top: 300,
      width: trigger ? 160 : 200,
      height: trigger ? 32 : 152,
      right: 100 + (trigger ? 160 : 200),
      bottom: 300 + (trigger ? 32 : 152),
      toJSON: () => ({})
    } as DOMRect
  }
  Element.prototype.scrollIntoView = () => undefined
  picked.mockClear()
  closed.mockClear()
  chose.mockClear()
  Object.assign(window, { zen: { invoke: async () => undefined, on: () => () => undefined } })
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth')
  vi.unstubAllGlobals()
})

describe('the menulist popup', () => {
  it('is a listbox in the chrome layer on the shared popup class, the current option checked and focused, the trigger’s width on it', () => {
    render()
    open()
    const el = list()!
    expect(el.closest('#zen-chrome-layer')).not.toBeNull()
    expect(el.className).toContain('zen-v2-menulist-popup')
    expect(el.className).toContain('zen-v2-panel')
    expect(el.getAttribute('aria-label')).toBe('Language')
    expect(el.style.getPropertyValue('--zen-anchor-width')).toBe('160px')
    // Flush under the trigger's box (300 + 32), start-aligned on it.
    expect(el.style.top).toBe('332px')
    expect(el.style.left).toBe('100px')
    const options = rows()
    expect(options.map((r) => r.getAttribute('aria-selected'))).toEqual([
      'false',
      'false',
      'true',
      'false',
      'false'
    ])
    expect(options[2].querySelector('svg')).not.toBeNull()
    expect(options[1].querySelector('svg')).toBeNull()
    expect(options[2].querySelector('.zen-v2-menulist-option-description')?.textContent).toBe(
      'Downloaded · 42 MB'
    )
    expect(document.activeElement).toBe(options[2])
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
  })

  it('with nothing picked checks no row and the first row takes the cursor', () => {
    render({ value: null })
    open()
    expect(rows().every((r) => r.getAttribute('aria-selected') === 'false')).toBe(true)
    expect(document.activeElement).toBe(rows()[0])
  })

  it('the arrows, Home and End move the cursor; Enter picks and closes', () => {
    render()
    open()
    const options = rows()
    key('ArrowDown')
    expect(document.activeElement).toBe(options[3])
    key('ArrowUp')
    key('ArrowUp')
    expect(document.activeElement).toBe(options[1])
    key('End')
    expect(document.activeElement).toBe(options[4])
    key('Home')
    expect(document.activeElement).toBe(options[0])
    click(options[0])
    expect(picked).toHaveBeenCalledWith('da')
    expect(list()).toBeNull()
  })

  it('letters type ahead: to the next option starting with the letter, the same letter cycling, a prefix within a second staying put', () => {
    let now = 10_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    render()
    open()
    const options = rows()
    key('d', options[2])
    expect(document.activeElement).toBe(options[0])
    now += 200
    key('d', options[0])
    expect(document.activeElement).toBe(options[1])
    // A second on, a new search: "e" lands on English, "s" 200 ms after it on Estonian.
    now += 1500
    key('e', options[1])
    expect(document.activeElement).toBe(options[2])
    now += 200
    key('s', options[2])
    expect(document.activeElement).toBe(options[3])
    // A letter with a modifier is not the list's.
    now += 1500
    key('f', options[3], { ctrlKey: true })
    expect(document.activeElement).toBe(options[3])
  })

  it('Escape closes it and hands the focus back to the trigger', () => {
    render()
    open()
    expect(document.activeElement).not.toBe(trigger())
    key('Escape')
    expect(list()).toBeNull()
    expect(closed).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(trigger())
  })

  it('action rows stand after a hairline and act instead of picking', () => {
    render({ withAction: true })
    open()
    const el = list()!
    const options = rows()
    expect(options).toHaveLength(6)
    expect(el.querySelector('[role="separator"]')?.className).toBe('zen-v2-menu-separator')
    expect(options[5].textContent).toBe('Choose another…')
    expect(options[5].getAttribute('aria-selected')).toBe('false')
    key('End')
    expect(document.activeElement).toBe(options[5])
    click(options[5])
    expect(chose).toHaveBeenCalledTimes(1)
    expect(picked).not.toHaveBeenCalled()
  })

  it('a font picker’s rows write their names in the chrome’s type with an "Aa" specimen in the face trailing, every row keeping the check’s slot (#350 review R5)', () => {
    render({
      value: 'Inter',
      options: [
        { value: '', label: 'Platform default' },
        { value: 'D050000L', label: 'D050000L', font: '"D050000L"' },
        { value: 'Inter', label: 'Inter', font: '"Inter"' }
      ]
    })
    open()
    const options = rows()
    // The label itself carries no face: a symbol face drawn in itself would write its name as
    // dingbats (§9.13: a row is its text).
    for (const option of options) {
      const label = option.querySelector<HTMLElement>('span')!
      expect(label.style.fontFamily).toBe('')
    }
    const specimen = (i: number): HTMLElement | null =>
      options[i].querySelector<HTMLElement>('.zen-v2-menulist-option-specimen')
    expect(specimen(0)).toBeNull()
    expect(specimen(1)?.textContent).toBe('Aa')
    // (happy-dom serialises the quoted family without its quotes.)
    expect(specimen(1)?.style.fontFamily.replace(/"/g, '')).toBe('D050000L')
    expect(specimen(1)?.getAttribute('aria-hidden')).toBe('true')
    expect(specimen(2)?.style.fontFamily.replace(/"/g, '')).toBe('Inter')
    // The specimen trails the label, before the check's slot; a row that is not the pick holds
    // the slot with a blank mark so every specimen ends on one line.
    expect(options[2].querySelector('svg')).not.toBeNull()
    expect(options[2].querySelector('.zen-v2-menulist-option-mark')).toBeNull()
    expect(options[1].querySelector('svg')).toBeNull()
    expect(options[1].querySelector('.zen-v2-menulist-option-mark')).not.toBeNull()
    expect(options[0].querySelector('.zen-v2-menulist-option-mark')).not.toBeNull()
    expect(options[1].lastElementChild?.classList.contains('zen-v2-menulist-option-mark')).toBe(
      true
    )
    expect(specimen(1)?.nextElementSibling).toBe(options[1].lastElementChild)
    // The accessible name is the label alone.
    expect(options[1].textContent).toBe('D050000LAa')
    expect(options[1].querySelector<HTMLElement>('span')?.textContent).toBe('D050000L')
  })

  it('a surface’s own class rides on the popup panel (a width floor for a list whose rows the trigger is narrower than)', () => {
    render({ className: 'zen-reader-translate-popup' })
    open()
    const el = list()!
    expect(el.classList.contains('zen-v2-menulist-popup')).toBe(true)
    expect(el.classList.contains('zen-reader-translate-popup')).toBe(true)
  })

  it('a list that fits its room is as wide as its rows; one taller than the room scrolls and is wider by the scrollbar, so the bar takes nothing from the rows (#350 lead check, the 25-stop size list)', () => {
    // A fine pointer's bar: the probe's 200 offset against a 192 client width is the chassis's 8.
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 192
    })
    render()
    open()
    // 152 of rows under a 768 window: whole, no bar, the rows' own 200.
    expect(list()!.style.width).toBe('200px')
    expect(list()!.style.maxHeight).toBe('152px')
    key('Escape')
    // 700 of rows: capped at the room below the trigger (768 − 332 − 8), scrolling, 8 wider.
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get: () => 700
    })
    open()
    expect(list()!.style.maxHeight).toBe('428px')
    expect(list()!.style.width).toBe('208px')
    key('Escape')
    // Rows already at §5's 332 cannot grow past it: the bar takes its width there, the row's
    // ellipsis is by design (the picker's longest family name).
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get: () => 330
    })
    open()
    expect(list()!.style.width).toBe('332px')
  })
})
