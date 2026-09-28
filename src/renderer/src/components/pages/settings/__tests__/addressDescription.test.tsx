// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type {
  ActionRow,
  FieldRow,
  InfoRow,
  ItemRow,
  SliderRow,
  SwitchRow,
  ValueRow
} from '../model'
import { RadioOption } from '../blocks'
import { RowView } from '../rows'

/*
 * §9.2's exception for a path or an address (services seed #29; the lead's ruling on #677): a
 * description that is a folder, a server's URL, a page's address or a host keeps its END – the
 * leaf, the page – so it is ONE line that never wraps, shortened from its start; a prose
 * description keeps §9.2's two lines and the end ellipsis. The row model carries the difference
 * as `address` (`RowBase.address`, `RowOption.address`), and every renderer that draws a
 * description – the phone's rows, the desktop's rows, the radio list's options – writes it as
 * the one modifier class `zen-settings-description-address` on the `zen-settings-description`
 * span, the value inside a `<bdi dir="ltr">` isolate: the span is laid out right-to-left so
 * CSS's `text-overflow` draws its ellipsis at the start, and the isolate keeps the value's own
 * order and its edge punctuation where they are. The whole value stays in the DOM – a reader,
 * a search and a copy get all of it – and nothing carries a native title (§9.31).
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLElement | null = null

function render(element: ReactElement): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root?.render(element))
  return host
}

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

const ctx = { open: vi.fn() }

const PATH = '/home/user/Downloads/Zenium'
const DAV = 'https://cloud.example.com/remote.php/dav/files/user/'

function rowOf(el: HTMLElement, id: string): HTMLElement {
  const row = el.querySelector<HTMLElement>(`[data-row="${id}"]`)
  if (!row) throw new Error(`no row ${id}`)
  return row
}

/** The row's description spans, in order. */
function descriptions(row: HTMLElement): HTMLElement[] {
  return [...row.querySelectorAll<HTMLElement>('.zen-settings-description')]
}

/** The one description of an address row: the modifier, the isolate, the whole value, no title. */
function expectAddress(row: HTMLElement, text: string): void {
  const [description, ...rest] = descriptions(row)
  expect(rest).toEqual([])
  expect(description).toBeDefined()
  expect(description.classList.contains('zen-settings-description-address')).toBe(true)
  const isolate = description.querySelector<HTMLElement>('bdi')
  expect(isolate).not.toBeNull()
  expect(isolate?.getAttribute('dir')).toBe('ltr')
  expect(isolate?.textContent).toBe(text)
  expect(description.textContent).toBe(text)
  expect(row.querySelector('[title]')).toBeNull()
}

/** The one description of a prose row: the base class alone, the text bare, no isolate. */
function expectProse(row: HTMLElement, text: string): void {
  const [description, ...rest] = descriptions(row)
  expect(rest).toEqual([])
  expect(description).toBeDefined()
  expect(description.className).toBe('zen-settings-description')
  expect(description.querySelector('bdi')).toBeNull()
  expect(description.textContent).toBe(text)
}

function info(patch: Partial<InfoRow> = {}): InfoRow {
  return {
    kind: 'info',
    id: 'sync-server-folder',
    label: 'Folder',
    description: 'Backups/Zenium',
    ...patch
  }
}

function action(patch: Partial<ActionRow> = {}): ActionRow {
  return {
    kind: 'action',
    id: 'download-directory',
    label: 'Location',
    description: PATH,
    onPress: () => undefined,
    ...patch
  }
}

function field(patch: Partial<FieldRow> = {}): FieldRow {
  return {
    kind: 'field',
    id: 'sync-webdav-url',
    label: 'Server address',
    value: DAV,
    input: 'url',
    onCommit: () => undefined,
    ...patch
  }
}

function toggle(patch: Partial<SwitchRow> = {}): SwitchRow {
  return {
    kind: 'switch',
    id: 'skill:cursor',
    label: 'Cursor',
    description: '~/.cursor/skills/zenium-browser',
    checked: true,
    onChange: () => undefined,
    ...patch
  }
}

function item(patch: Partial<ItemRow> = {}): ItemRow {
  return {
    kind: 'item',
    id: 'startup-1',
    label: 'Example',
    description: 'https://example.com/a/very/long/path/(draft)',
    sheet: { title: 'Example', groups: [] },
    ...patch
  }
}

function choice(patch: Partial<ValueRow> = {}): ValueRow {
  return {
    kind: 'value',
    id: 'search-engine',
    label: 'Search engine',
    value: 'forum',
    description: 'The engine the address bar searches with.',
    options: [
      { value: 'google', label: 'Google' },
      { value: 'forum', label: 'Forum', description: 'forum.example', address: true }
    ],
    onChange: () => undefined,
    ...patch
  }
}

function slider(patch: Partial<SliderRow> = {}): SliderRow {
  return {
    kind: 'slider',
    id: 'zoom',
    label: 'Zoom',
    description: PATH,
    value: 1,
    min: 0,
    max: 2,
    step: 1,
    format: (v) => `${v}`,
    onChange: () => undefined,
    ...patch
  }
}

describe('a path or address description on the phone’s rows (§9.2’s exception)', () => {
  it('an info row’s flagged line is the one-line, start-shortened span: the modifier class, an LTR isolate holding the whole value, no title', () => {
    const el = render(<RowView row={info({ address: true })} ctx={ctx} />)
    expectAddress(rowOf(el, 'sync-server-folder'), 'Backups/Zenium')
  })

  it('an action row keeps a folder’s end the same way; the same row without the flag is prose', () => {
    const flagged = render(<RowView row={action({ address: true })} ctx={ctx} />)
    expectAddress(rowOf(flagged, 'download-directory'), PATH)
    act(() => root?.unmount())
    host?.remove()
    const prose = render(
      <RowView row={action({ description: 'The system Downloads folder' })} ctx={ctx} />
    )
    expectProse(rowOf(prose, 'download-directory'), 'The system Downloads folder')
  })

  it('a field row’s line is its value (its display when it has one), and `address` names that line', () => {
    const value = render(<RowView row={field({ address: true })} ctx={ctx} />)
    expectAddress(rowOf(value, 'sync-webdav-url'), DAV)
    act(() => root?.unmount())
    host?.remove()
    const shown = render(
      <RowView row={field({ address: true, value: '/x/y', display: 'Backups/Zenium' })} ctx={ctx} />
    )
    expectAddress(rowOf(shown, 'sync-webdav-url'), 'Backups/Zenium')
  })

  it('a switch row, an item row and a labelled slider row carry the flag to their line too', () => {
    const el = render(
      <>
        <RowView row={toggle({ address: true })} ctx={ctx} />
        <RowView row={item({ address: true })} ctx={ctx} />
        <RowView row={slider({ address: true })} ctx={ctx} />
      </>
    )
    expectAddress(rowOf(el, 'skill:cursor'), '~/.cursor/skills/zenium-browser')
    expectAddress(rowOf(el, 'startup-1'), 'https://example.com/a/very/long/path/(draft)')
    expectAddress(rowOf(el, 'zoom'), PATH)
  })

  it('the picker sheet’s option (`RadioOption`, the one primitive the phone’s OptionsSheet and the desktop’s radio list share) writes the flag on its line', () => {
    const el = render(
      <div role="radiogroup">
        <RadioOption label="Google" checked={false} onSelect={() => undefined} />
        <RadioOption
          label="Forum"
          description="forum.example"
          address
          checked
          onSelect={() => undefined}
        />
      </div>
    )
    const [google, forum] = [...el.querySelectorAll<HTMLElement>('[role="radio"]')]
    expect(google.querySelector('.zen-settings-description')).toBeNull()
    const line = forum.querySelector<HTMLElement>('.zen-settings-description')
    expect(line?.classList.contains('zen-settings-description-address')).toBe(true)
    expect(line?.querySelector('bdi[dir="ltr"]')?.textContent).toBe('forum.example')
    expect(forum.querySelector('[title]')).toBeNull()
  })
})

describe('the same flag on the desktop’s rows', () => {
  it('an action row with a button, a check row, a menulist row and a slider row write the modifier on their line', () => {
    const el = render(
      <>
        <RowView row={action({ address: true, button: 'Change…' })} ctx={ctx} variant="desktop" />
        <RowView row={toggle({ address: true })} ctx={ctx} variant="desktop" />
        <RowView row={choice({ description: DAV, address: true })} ctx={ctx} variant="desktop" />
        <RowView row={slider({ address: true })} ctx={ctx} variant="desktop" />
      </>
    )
    expectAddress(rowOf(el, 'download-directory'), PATH)
    expectAddress(rowOf(el, 'skill:cursor'), '~/.cursor/skills/zenium-browser')
    expectAddress(rowOf(el, 'search-engine'), DAV)
    expectAddress(rowOf(el, 'zoom'), PATH)
  })

  it('a pressable action row and an item row with an action keep a page’s end on the desktop as on the phone', () => {
    const el = render(
      <>
        <RowView row={action({ address: true })} ctx={ctx} variant="desktop" />
        <RowView
          row={item({ address: true, action: { label: 'Remove', onPress: () => undefined } })}
          ctx={ctx}
          variant="desktop"
        />
      </>
    )
    expectAddress(rowOf(el, 'download-directory'), PATH)
    expectAddress(rowOf(el, 'startup-1'), 'https://example.com/a/very/long/path/(draft)')
  })

  it('the radio list flags the row’s line and each option’s line separately: a prose row over a host', () => {
    const el = render(<RowView row={choice({ radios: true })} ctx={ctx} variant="desktop" />)
    const row = rowOf(el, 'search-engine')
    const [head, ...options] = descriptions(row)
    expect(head.className).toBe('zen-settings-description')
    expect(head.textContent).toBe('The engine the address bar searches with.')
    expect(
      options.map((o) => [o.textContent, o.classList.contains('zen-settings-description-address')])
    ).toEqual([['forum.example', true]])
    expect(options[0].querySelector('bdi[dir="ltr"]')?.textContent).toBe('forum.example')
  })

  it('the desktop’s field row draws its hint beside the field, prose whatever the flag says: the value is in the field, whole', () => {
    const el = render(
      <RowView
        row={field({ address: true, description: 'The WebDAV address your provider gives you.' })}
        ctx={ctx}
        variant="desktop"
      />
    )
    const row = rowOf(el, 'sync-webdav-url')
    expectProse(row, 'The WebDAV address your provider gives you.')
    expect(row.querySelector('input')?.value).toBe(DAV)
  })
})

describe('the two lines stay for prose', () => {
  /** main.css without its comments, one space for every run of whitespace. */
  function stylesheet(): string {
    return readFileSync(resolve(__dirname, '../../../../assets/main.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\s+/g, ' ')
  }

  /** The declarations of the first rule whose selector is exactly `selector`. */
  function declarations(css: string, selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const m = css.match(new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^}]*)\\}`))
    if (!m) throw new Error(`no rule for ${selector}`)
    return m[1].trim()
  }

  it('a prose description renders the base span alone – no modifier, no isolate – on both renderers', () => {
    const el = render(
      <>
        <RowView row={info()} ctx={ctx} />
        <RowView
          row={action({ description: 'Choose a folder that your cloud drive keeps in sync.' })}
          ctx={ctx}
          variant="desktop"
        />
      </>
    )
    expectProse(rowOf(el, 'sync-server-folder'), 'Backups/Zenium')
    expectProse(
      rowOf(el, 'download-directory'),
      'Choose a folder that your cloud drive keeps in sync.'
    )
  })

  it('main.css keeps §9.2’s two-line clamp on the base span and lifts it only on the address modifier, which is one nowrap line laid out right-to-left with the ellipsis', () => {
    const css = stylesheet()
    const base = declarations(css, '.zen-settings-description')
    expect(base).toContain('display: -webkit-box')
    expect(base).toContain('-webkit-line-clamp: 2')
    expect(base).toContain('overflow: hidden')
    expect(base).not.toContain('white-space')
    const modifier = declarations(css, '.zen-settings-description-address')
    expect(modifier).toContain('display: block')
    expect(modifier).toContain('direction: rtl')
    expect(modifier).toContain('text-align: left')
    expect(modifier).toContain('white-space: nowrap')
    expect(modifier).toContain('text-overflow: ellipsis')
    expect(modifier).toContain('-webkit-line-clamp: none')
    // The modifier comes after the base rule, so its one line wins at equal specificity.
    expect(css.indexOf('.zen-settings-description-address {')).toBeGreaterThan(
      css.indexOf('.zen-settings-description {')
    )
  })
})
