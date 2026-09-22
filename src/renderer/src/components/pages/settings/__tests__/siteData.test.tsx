// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings, UIState } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import {
  CLEAR_ON_EXIT_TYPES,
  emptySiteDataStatus,
  type SiteDataListing,
  type SiteDataOriginRow,
  type SiteDataStatus
} from '@shared/siteData'

/*
 * Cookies and site data in Settings (#310's UI half; PS-23, PS-24, PS-25): the groups the
 * `privacySection` builder places (siteDataRows.tsx) as data – the default's §9.13 picker with
 * the browser-wide block-all line, a group per list with its rows, its empty line and its Add
 * row, a switch row per on-exit type, the viewer's row – and what each asks of the engine; the
 * Add form (§9.12: the hint, the refusal, Add at .4, the busy form, the engine's refusal back in
 * the field); and the viewer (the rows and their lines, the count aside, the cap's and the
 * sizes-unavailable notes, a row's Clear leaving the list, Clear all in the footer slot with
 * its prompt over the dialog – inert under it, Escape to the prompt alone, the focus back on
 * Clear all when it has gone).
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })

const { siteDataGroups } = await import('../siteDataRows')
const { AddPatternForm } = await import('../AddPatternForm')
const { SiteDataViewer } = await import('../SiteDataViewer')
const { SettingsDialog } = await import('../dialogs')
const { allRows, findRow } = await import('../model')
const { FrameDialogHost } = await import('@renderer/lib/portals')
const { viewportStore } = await import('@renderer/lib/formFactor')
const { SITE_DATA_TEXT } = await import('@renderer/lib/siteDataUi')

type Ctx = Parameters<typeof siteDataGroups>[0]

function status(over: Partial<SiteDataStatus> = {}): SiteDataStatus {
  return { ...emptySiteDataStatus(), ...over }
}

/** The slice of the state the builder reads: the policy, the host's windows, the privacy settings. */
function state(siteData: SiteDataStatus, windows = false): UIState {
  return {
    platform: windows ? 'linux' : 'android',
    capabilities: { windows },
    settings: DEFAULT_SETTINGS,
    siteData
  } as unknown as UIState
}

function context(
  siteData: SiteDataStatus = status(),
  windows = false
): { ctx: Ctx; patches: Partial<Settings>[] } {
  const patches: Partial<Settings>[] = []
  const ctx = {
    state: state(siteData, windows),
    set: (patch: Partial<Settings>) => patches.push(patch)
  } as unknown as Ctx
  return { ctx, patches }
}

function origin(over: Partial<SiteDataOriginRow> = {}): SiteDataOriginRow {
  return {
    origin: 'https://example.com',
    site: 'example.com',
    cookies: 3,
    usageBytes: 4096,
    permissions: [],
    state: 'default',
    ...over
  }
}

function listing(over: Partial<SiteDataListing> = {}): SiteDataListing {
  return {
    rows: [
      origin(),
      origin({
        origin: 'https://news.example',
        site: 'news.example',
        cookies: 1,
        usageBytes: null
      }),
      origin({
        origin: 'http://127.0.0.1:18131',
        site: '127.0.0.1',
        cookies: 10,
        usageBytes: null,
        state: 'clear-on-exit'
      })
    ],
    total: 3,
    truncated: false,
    sized: true,
    ...over
  }
}

let root: Root | null = null
let mount: HTMLElement | null = null

function render(el: ReactElement): HTMLElement {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(el))
  return mount
}

/** Let the pending promises settle, a few turns deep (and happy-dom's animation frame with them). */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 20))
  })
}

function type(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function buttons(el: ParentNode): HTMLButtonElement[] {
  return Array.from(el.querySelectorAll('button'))
}

function button(el: ParentNode, label: string): HTMLButtonElement {
  const found = buttons(el).find((b) => b.textContent === label)
  if (!found) throw new Error(`no button ${label}`)
  return found
}

function escape(): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
}

beforeEach(() => {
  invoke.mockClear()
  invoke.mockImplementation(async () => null)
})
afterEach(() => {
  if (root) act(() => root!.unmount())
  mount?.remove()
  root = null
  mount = null
})

// ---------------------------------------------------------------------------
// The rows
// ---------------------------------------------------------------------------

describe('the Cookies and site data groups', () => {
  it('stand in order: the default, a group and an Add row per list, the on-exit types, the viewer', () => {
    const { ctx } = context()
    expect(siteDataGroups(ctx).map((g) => g.id)).toEqual([
      'site-data',
      'site-data-allow',
      'site-data-allow-add',
      'site-data-clearOnExit',
      'site-data-clearOnExit-add',
      'site-data-block',
      'site-data-block-add',
      'site-data-exit',
      'site-data-viewer'
    ])
    const ids = allRows(siteDataGroups(ctx)).map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('offer the default as a value row with Chrome’s three radios, block-all saying it is browser-wide, and run siteData.setDefault', () => {
    const { ctx } = context()
    const groups = siteDataGroups(ctx)
    expect(groups[0]!.heading).toBe('Cookies and site data')
    const row = findRow(groups, 'site-data-default')
    if (row?.kind !== 'value') throw new Error('not a value row')
    expect(row.label).toBe('Default behaviour')
    expect(row.value).toBe('block-third-party')
    expect(row.options.map((o) => o.label)).toEqual([
      'Allow all cookies',
      'Block third-party cookies',
      'Block all cookies'
    ])
    expect(row.options[2]!.description).toMatch(/^Browser-wide, not per site/)
    row.onChange('block-all')
    expect(invoke).toHaveBeenCalledWith('siteData.setDefault', { default: 'block-all' })
  })

  it('draw each list’s patterns as item rows with the list’s word under them, the empty line when there are none', () => {
    const { ctx } = context(
      status({
        allow: ['[*.]example.com'],
        block: ['news.example', 'https://tracker.example:8443'],
        clearsAtNextLaunch: true
      })
    )
    const groups = siteDataGroups(ctx)
    const allow = groups.find((g) => g.id === 'site-data-allow')!
    expect(allow.heading).toBe('Sites that can always use cookies')
    expect(allow.rows.map((r) => r.label)).toEqual(['[*.]example.com'])
    expect(allow.rows[0]!.description).toBe('Can always use cookies')
    expect(allow.empty).toBe('No sites added')

    const exit = groups.find((g) => g.id === 'site-data-clearOnExit')!
    expect(exit.heading).toBe('Always clear cookies when Zenium closes')
    expect(exit.description).toContain('the next time Zenium starts')
    expect(exit.rows).toEqual([])
    expect(exit.empty).toBe('No sites added')

    const block = groups.find((g) => g.id === 'site-data-block')!
    expect(block.rows.map((r) => r.id)).toEqual([
      'site-data-site:news.example',
      'site-data-site:https://tracker.example:8443'
    ])
    for (const row of block.rows) expect(row.description).toBe('Can never use cookies')
  })

  it('head the on-exit list with the windows’ close on a desktop', () => {
    const { ctx } = context(status(), true)
    const exit = siteDataGroups(ctx).find((g) => g.id === 'site-data-clearOnExit')!
    expect(exit.heading).toBe('Always clear cookies when windows are closed')
    expect(exit.description).toContain('when Zenium closes')
  })

  it('give a pattern’s sheet one action, Remove, which runs siteData.remove for the pattern as it stands', () => {
    const { ctx } = context(status({ block: ['[*.]example.com'] }))
    const row = findRow(siteDataGroups(ctx), 'site-data-site:[*.]example.com')
    if (row?.kind !== 'item') throw new Error('not an item row')
    expect(row.sheet.title).toBe('[*.]example.com')
    expect(row.sheet.description).toBe('Sites that can never use cookies')
    const actions = allRows(row.sheet.groups)
    expect(actions).toHaveLength(1)
    const remove = actions[0]!
    if (remove.kind !== 'action') throw new Error('not an action row')
    expect(remove.label).toBe('Remove from the list')
    expect(remove.button).toBe('Remove')
    remove.onPress?.()
    expect(invoke).toHaveBeenCalledWith('siteData.remove', { pattern: '[*.]example.com' })
  })

  it('give each list an Add row whose sheet is the pattern form, titled for the list', () => {
    const { ctx } = context()
    for (const list of ['allow', 'clearOnExit', 'block'] as const) {
      const row = findRow(siteDataGroups(ctx), `site-data-${list}-add`)
      if (row?.kind !== 'action') throw new Error('not an action row')
      expect(row.label).toBe('Add a site')
      expect(row.button).toBe('Add…')
      expect(row.form?.title).toBe('Add a site')
      expect(row.form?.description).toBe(
        siteDataGroups(ctx).find((g) => g.id === `site-data-${list}`)!.heading
      )
      expect(row.form?.render).toBeTypeOf('function')
    }
  })

  it('offer one switch row per on-exit type – never passwords – patching privacy.clearOnExit in the dialog’s order', () => {
    const { ctx, patches } = context(status({ clearOnExitTypes: ['cache'] }))
    const exit = siteDataGroups(ctx).find((g) => g.id === 'site-data-exit')!
    expect(exit.heading).toBe('Delete browsing data on exit')
    expect(exit.description).toContain('Saved passwords are never cleared this way')
    expect(exit.rows.map((r) => r.id)).toEqual(
      CLEAR_ON_EXIT_TYPES.map((type) => `site-data-exit:${type}`)
    )
    expect(exit.rows.map((r) => r.label)).not.toContain('Saved passwords')
    const history = exit.rows.find((r) => r.id === 'site-data-exit:history')
    if (history?.kind !== 'switch') throw new Error('not a switch row')
    expect(history.label).toBe('Browsing history')
    expect(history.checked).toBe(false)
    const cache = exit.rows.find((r) => r.id === 'site-data-exit:cache')
    if (cache?.kind !== 'switch') throw new Error('not a switch row')
    expect(cache.checked).toBe(true)
    history.onChange(true)
    expect(patches).toEqual([
      { privacy: { ...DEFAULT_SETTINGS.privacy, clearOnExit: { types: ['history', 'cache'] } } }
    ])
    cache.onChange(false)
    expect(patches[1]).toEqual({
      privacy: { ...DEFAULT_SETTINGS.privacy, clearOnExit: { types: [] } }
    })
  })

  it('say when the host clears at the next launch and while a clear is still owed', () => {
    const { ctx } = context(status({ clearsAtNextLaunch: true, pendingClear: true }))
    const exit = siteDataGroups(ctx).find((g) => g.id === 'site-data-exit')!
    expect(exit.description).toContain('the next time Zenium starts')
    expect(exit.description).toContain('still running')
  })

  it('end with the viewer’s row, whose sheet is the viewer', () => {
    const { ctx } = context()
    const row = findRow(siteDataGroups(ctx), 'site-data-see-all')
    if (row?.kind !== 'action') throw new Error('not an action row')
    expect(row.label).toBe('See all site data and permissions')
    expect(row.button).toBe('See all…')
    expect(row.form?.title).toBe('Site data')
    expect(row.form?.description).toContain('Clearing a site signs you out of it')
  })
})

// ---------------------------------------------------------------------------
// The Add form
// ---------------------------------------------------------------------------

describe('the Add a site form', () => {
  function form(
    list: 'allow' | 'clearOnExit' | 'block' = 'block',
    s: SiteDataStatus = status(),
    close = vi.fn()
  ): { el: HTMLElement; close: ReturnType<typeof vi.fn>; input: HTMLInputElement } {
    const el = render(createElement(AddPatternForm, { list, status: s, windows: false, close }))
    const input = el.querySelector<HTMLInputElement>('input')!
    return { el, close, input }
  }

  it('is one field with the grammar’s hint under it, Add at .4 until something is typed', () => {
    const { el, input } = form()
    expect(el.querySelector('label')?.textContent).toBe('Site')
    expect(input.placeholder).toBe('[*.]example.com')
    expect(input.classList.contains('zen-v2-field')).toBe(true)
    expect(input.getAttribute('inputmode')).toBe('url')
    expect(el.textContent).toContain(SITE_DATA_TEXT.lists.fieldHint)
    expect(button(el, 'Add a site').disabled).toBe(true)
    type(input, 'example.com')
    expect(button(el, 'Add a site').disabled).toBe(false)
    expect(el.textContent).toContain(SITE_DATA_TEXT.lists.fieldHint)
  })

  it('refuses text that is not a pattern under the field, Add waiting, and a duplicate the same way', () => {
    const { el, input } = form('block', status({ block: ['[*.]example.com'] }))
    type(input, 'not a pattern!')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(el.textContent).toContain(SITE_DATA_TEXT.lists.invalid)
    expect(el.textContent).not.toContain(SITE_DATA_TEXT.lists.fieldHint)
    expect(button(el, 'Add a site').disabled).toBe(true)
    act(() => button(el, 'Add a site').click())
    expect(invoke).not.toHaveBeenCalled()

    type(input, '[*.]example.com')
    expect(el.textContent).toContain(SITE_DATA_TEXT.lists.duplicate)
    expect(button(el, 'Add a site').disabled).toBe(true)
  })

  it('says a pattern on another list moves, and lets Add go', () => {
    const { el, input } = form('allow', status({ block: ['[*.]example.com'] }))
    type(input, '[*.]example.com')
    expect(input.getAttribute('aria-invalid')).toBeNull()
    expect(el.textContent).toContain(
      'Currently under “Sites that can never use cookies”; adding moves it here'
    )
    expect(button(el, 'Add a site').disabled).toBe(false)
  })

  it('is a busy form while the engine adds – the field read-only, Add busy – and closes once it has', async () => {
    let finish: (value: unknown) => void = () => undefined
    invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const { el, close, input } = form()
    type(input, ' news.example ')
    act(() => button(el, 'Add a site').click())
    expect(invoke).toHaveBeenCalledWith('siteData.add', { list: 'block', pattern: 'news.example' })
    expect(input.readOnly).toBe(true)
    expect(input.value).toBe(' news.example ')
    expect(button(el, 'Add a site').getAttribute('aria-busy')).toBe('true')
    expect(el.querySelector('[data-testid="add-pattern-form"]')?.getAttribute('aria-busy')).toBe(
      'true'
    )
    expect(close).not.toHaveBeenCalled()
    act(() => finish({ ok: true, pattern: 'news.example' }))
    await settle()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('submits on Enter too, and Cancel closes without sending', () => {
    invoke.mockImplementation(async () => ({ ok: true, pattern: 'news.example' }))
    const { el, close, input } = form()
    act(() => button(el, 'Cancel').click())
    expect(close).toHaveBeenCalledTimes(1)
    expect(invoke).not.toHaveBeenCalled()
    type(input, 'news.example')
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(invoke).toHaveBeenCalledWith('siteData.add', { list: 'block', pattern: 'news.example' })
  })

  it('puts the engine’s refusal under the field, the field emptied and focused, and stays open', async () => {
    invoke.mockImplementationOnce(async () => ({ ok: false, problem: 'That list is full' }))
    const { el, close, input } = form()
    type(input, 'news.example')
    act(() => button(el, 'Add a site').click())
    await settle()
    expect(close).not.toHaveBeenCalled()
    expect(el.textContent).toContain('That list is full')
    expect(input.value).toBe('')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(input)
    expect(button(el, 'Add a site').disabled).toBe(true)
    // Typing again clears the refusal and brings the hint back.
    type(input, 'other.example')
    expect(el.textContent).not.toContain('That list is full')
    expect(el.textContent).toContain(SITE_DATA_TEXT.lists.fieldHint)
  })
})

// ---------------------------------------------------------------------------
// The viewer
// ---------------------------------------------------------------------------

describe('the site-data viewer', () => {
  function rows(el: ParentNode): HTMLElement[] {
    return Array.from(el.querySelectorAll<HTMLElement>('[data-row^="site-data-origin:"]'))
  }
  function rowText(row: HTMLElement): { label: string; description: string } {
    return {
      label: row.querySelector('.zen-settings-label')?.textContent ?? '',
      description: row.querySelector('.zen-settings-description')?.textContent ?? ''
    }
  }

  it('reads while the engine lists, then draws a two-line row per origin under Sites with the count aside', async () => {
    let finish: (value: unknown) => void = () => undefined
    invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const el = render(createElement(SiteDataViewer))
    expect(invoke).toHaveBeenCalledWith('siteData.list', undefined)
    expect(el.textContent).toContain('Reading…')
    expect(el.querySelector('[data-group="site-data-origins"]')?.getAttribute('aria-busy')).toBe(
      'true'
    )
    expect(button(el, 'Clear all').disabled).toBe(true)
    act(() => finish(listing()))
    await settle()
    expect(el.textContent).not.toContain('Reading…')
    expect(el.querySelector('h3')?.textContent).toContain('Sites')
    expect(el.querySelector('[data-testid="site-data-count"]')?.textContent).toBe('3 sites')
    expect(rows(el).map(rowText)).toEqual([
      { label: 'example.com', description: '3 cookies · 4 KB' },
      { label: 'news.example', description: '1 cookie' },
      { label: 'http://127.0.0.1:18131', description: '10 cookies · Cleared on exit' }
    ])
    for (const row of rows(el)) {
      // The row is the page's static control row (§9.21, §9.34): the control the target, not the row.
      expect(row.hasAttribute('data-static')).toBe(true)
      expect(row.classList.contains('zen-v2-row')).toBe(true)
      expect(row.querySelector('.zen-settings-control button')?.textContent).toBe('Clear')
      expect(row.querySelector('button')?.getAttribute('data-danger')).toBe('true')
    }
    expect(rows(el)[0]!.querySelector('button')?.getAttribute('aria-label')).toBe(
      'Clear example.com'
    )
    expect(button(el, 'Clear all').disabled).toBe(false)
    expect(button(el, 'Clear all').getAttribute('data-danger')).toBe('true')
    // Nothing under the heading: every origin sized, the listing whole.
    expect(el.querySelector('.zen-settings-group-description')).toBeNull()
  })

  it('writes the cap’s line and the count of the whole under the heading when the listing stopped at the cap', async () => {
    invoke.mockImplementationOnce(async () => listing({ total: 1204, truncated: true }))
    const el = render(createElement(SiteDataViewer))
    await settle()
    expect(el.querySelector('[data-testid="site-data-count"]')?.textContent).toBe(
      '1,000 of 1,204 sites'
    )
    expect(el.querySelector('.zen-settings-group-description')?.textContent).toBe(
      'Showing the 1,000 sites with the most data of 1,204.'
    )
  })

  it('says once that sizes are unavailable where no origin could be sized, never per row', async () => {
    invoke.mockImplementationOnce(async () =>
      listing({
        sized: false,
        rows: [
          origin({ usageBytes: null }),
          origin({
            origin: 'https://b.example',
            site: 'b.example',
            usageBytes: null,
            cookies: 0,
            permissions: [{ permission: 'camera', decision: 'allow' }]
          })
        ]
      })
    )
    const el = render(createElement(SiteDataViewer))
    await settle()
    expect(el.querySelector('.zen-settings-group-description')?.textContent).toBe(
      'Sizes are unavailable on this device.'
    )
    expect(rows(el).map((r) => rowText(r).description)).toEqual(['3 cookies', '1 permission'])
    expect(el.textContent?.match(/unavailable/g)).toHaveLength(1)
  })

  it('shows the empty line with Clear all at .4 when nothing is stored, and the failure line when the engine did not answer', async () => {
    invoke.mockImplementationOnce(async () => listing({ rows: [], total: 0, sized: false }))
    const el = render(createElement(SiteDataViewer))
    await settle()
    expect(el.querySelector('.zen-settings-empty')?.textContent).toBe(
      'No site has stored anything yet'
    )
    expect(button(el, 'Clear all').disabled).toBe(true)
    expect(el.querySelector('[data-testid="site-data-count"]')?.textContent).toBe('0 sites')
    act(() => root!.unmount())
    root = null

    invoke.mockImplementationOnce(async () => {
      throw new Error('no engine')
    })
    const failed = render(createElement(SiteDataViewer))
    await settle()
    const line = failed.querySelector<HTMLElement>('.zen-settings-empty')
    expect(line?.textContent).toBe('That did not work. Try again.')
    expect(line?.dataset.tone).toBe('danger')
  })

  it('clears one origin from its row: the button busy while the engine works, the row gone after, the count following', async () => {
    invoke.mockImplementationOnce(async () => listing())
    const el = render(createElement(SiteDataViewer))
    await settle()
    let finish: (value: unknown) => void = () => undefined
    invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const clear = rows(el)[1]!.querySelector('button')!
    act(() => clear.click())
    expect(invoke).toHaveBeenLastCalledWith('siteData.clearSite', {
      origin: 'https://news.example'
    })
    expect(clear.getAttribute('aria-busy')).toBe('true')
    // A second press while busy sends nothing.
    act(() => clear.click())
    expect(invoke).toHaveBeenCalledTimes(2)
    act(() => finish(null))
    await settle()
    expect(rows(el).map((r) => rowText(r).label)).toEqual(['example.com', 'http://127.0.0.1:18131'])
    expect(el.querySelector('[data-testid="site-data-count"]')?.textContent).toBe('2 sites')
  })

  it('keeps a row whose Clear the engine refused, its line the failure in the danger ink', async () => {
    invoke.mockImplementationOnce(async () => listing())
    const el = render(createElement(SiteDataViewer))
    await settle()
    invoke.mockImplementationOnce(async () => {
      throw new Error('locked')
    })
    act(() => rows(el)[0]!.querySelector('button')!.click())
    await settle()
    const row = rows(el)[0]!
    expect(rowText(row)).toEqual({
      label: 'example.com',
      description: 'That did not work. Try again.'
    })
    expect(row.dataset.tone).toBe('danger')
    expect(rows(el)).toHaveLength(3)
  })

  it('a row with the cap behind it: the total follows the row out and the cap’s line stays while more are behind', async () => {
    invoke.mockImplementationOnce(async () => listing({ total: 5, truncated: true }))
    const el = render(createElement(SiteDataViewer))
    await settle()
    expect(el.querySelector('[data-testid="site-data-count"]')?.textContent).toBe(
      '1,000 of 5 sites'
    )
    invoke.mockImplementationOnce(async () => null)
    act(() => rows(el)[0]!.querySelector('button')!.click())
    await settle()
    expect(el.querySelector('[data-testid="site-data-count"]')?.textContent).toBe(
      '1,000 of 4 sites'
    )
    expect(rows(el)).toHaveLength(2)
  })

  describe('in the desktop dialog', () => {
    beforeEach(() => {
      viewportStore.set({
        ...viewportStore.get(),
        formFactor: 'desktop',
        width: 1280,
        height: 800,
        coarse: false,
        hover: true
      })
    })

    function open(): { el: HTMLElement; onClose: ReturnType<typeof vi.fn> } {
      const onClose = vi.fn()
      const el = render(
        createElement(
          FrameDialogHost,
          null,
          createElement(SettingsDialog, {
            name: 'form:site-data-see-all',
            title: 'Site data',
            description: 'Sites that stored cookies or data on this device.',
            under: false,
            onClose,
            children: createElement(SiteDataViewer)
          })
        )
      )
      return { el, onClose }
    }
    const dialogs = (el: ParentNode): HTMLElement[] =>
      Array.from(el.querySelectorAll<HTMLElement>('[role="dialog"]'))
    const viewerDialog = (el: ParentNode): HTMLElement =>
      el.querySelector<HTMLElement>('[data-dialog="form:site-data-see-all"]')!
    // A prompt on its way out (the host keeps the panel `data-leaving`, inert and hidden through
    // the §9.5 pop in reverse) is gone for the user and for this reading.
    const prompt = (el: ParentNode): HTMLElement | null =>
      el.querySelector<HTMLElement>(
        '[data-dialog="confirm:site-data-clear-all"]:not([data-leaving])'
      )

    it('puts Clear all in the dialog’s footer slot under the body, not in the body that scrolls', async () => {
      invoke.mockImplementationOnce(async () => listing())
      const { el } = open()
      await settle()
      const footer = el.querySelector<HTMLElement>('[data-testid="settings-dialog-footer"]')
      expect(footer).not.toBeNull()
      expect(footer!.querySelector('button')?.textContent).toBe('Clear all')
      expect(footer!.closest('.zen-settings-dialog-body')).toBeNull()
      expect(footer!.previousElementSibling?.classList.contains('zen-settings-dialog-body')).toBe(
        true
      )
      expect(viewerDialog(el).querySelector('[data-testid="site-data-viewer"]')).not.toBeNull()
    })

    it('prompts before clearing all: the prompt over the viewer’s dialog, which stands inert; Cancel takes the focus; Escape closes the prompt alone and the focus returns to Clear all', async () => {
      invoke.mockImplementationOnce(async () => listing())
      const { el, onClose } = open()
      await settle()
      const clearAll = button(el, 'Clear all')
      expect(clearAll.getAttribute('aria-haspopup')).toBe('dialog')
      act(() => clearAll.focus())
      act(() => clearAll.click())
      expect(dialogs(el)).toHaveLength(2)
      const p = prompt(el)!
      expect(p.querySelector('h2, h1, [id]')?.textContent ?? p.textContent).toContain(
        'Clear all site data?'
      )
      expect(p.textContent).toContain('signs you out everywhere')
      expect(viewerDialog(el).hasAttribute('inert')).toBe(true)
      expect(p.hasAttribute('inert')).toBe(false)
      expect(document.activeElement).toBe(button(p, 'Cancel'))
      expect(invoke).toHaveBeenCalledTimes(1)

      escape()
      expect(prompt(el)).toBeNull()
      expect(onClose).not.toHaveBeenCalled()
      expect(viewerDialog(el).hasAttribute('inert')).toBe(false)
      await settle()
      expect(document.activeElement).toBe(clearAll)

      // The next Escape is the viewer dialog's.
      escape()
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('clears everything on the prompt’s Clear all: siteData.clearAll, then the empty line', async () => {
      invoke.mockImplementationOnce(async () => listing())
      const { el } = open()
      await settle()
      act(() => button(el, 'Clear all').click())
      const p = prompt(el)!
      invoke.mockImplementationOnce(async () => null)
      act(() => button(p, 'Clear all').click())
      expect(invoke).toHaveBeenLastCalledWith('siteData.clearAll', undefined)
      await settle()
      expect(prompt(el)).toBeNull()
      expect(rows(el)).toHaveLength(0)
      expect(el.querySelector('.zen-settings-empty')?.textContent).toBe(
        'No site has stored anything yet'
      )
      expect(el.querySelector('[data-testid="site-data-count"]')?.textContent).toBe('0 sites')
      expect(button(el, 'Clear all').disabled).toBe(true)
    })

    it('keeps the rows and says so when Clear all was refused', async () => {
      invoke.mockImplementationOnce(async () => listing())
      const { el } = open()
      await settle()
      act(() => button(el, 'Clear all').click())
      invoke.mockImplementationOnce(async () => {
        throw new Error('locked')
      })
      act(() => button(prompt(el)!, 'Clear all').click())
      await settle()
      expect(rows(el)).toHaveLength(3)
      const alert = el.querySelector<HTMLElement>('[role="alert"]')
      expect(alert?.textContent).toBe('That did not work. Try again.')
      expect(alert?.dataset.tone).toBe('danger')
      expect(button(el, 'Clear all').disabled).toBe(false)
    })
  })
})
