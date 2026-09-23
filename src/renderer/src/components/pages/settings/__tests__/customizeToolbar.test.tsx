// @vitest-environment happy-dom
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FormFactor, Settings, Tab, UIState } from '@shared/types'
import { INTERNAL_PAGES } from '@shared/internalPages'
import {
  DEFAULT_CONTAINERS,
  DEFAULT_SETTINGS,
  emptyAgentServerStatus,
  emptyAutofillUIState,
  emptyPasswordsStatus,
  emptyResourceSnapshot
} from '@shared/defaults'
import { DEFAULT_PAGE_ENVIRONMENT } from '@shared/pageControls'
import { DEFAULT_SEARCH_ENGINES } from '@shared/search'
import { defaultShortcuts } from '@shared/shortcuts'
import { UNAVAILABLE_SPELLCHECK } from '@shared/spellcheck'
import { emptyBlockingStatus } from '@shared/blocking'
import { emptyPrivacyStatus } from '@shared/privacy'
import { emptySiteDataStatus } from '@shared/siteData'
import { emptyUpdateStatus } from '@shared/updates'
import { FrameDialogHost } from '@renderer/lib/portals'
import { toolbarTiering } from '@renderer/lib/toolbarPins'

/*
 * Look and Feel › Appearance's toolbar rows (settings-36; Chrome's toolbar customisation): the
 * "Show forward button" switch, the "Customise toolbar" row and its 400 form dialog – the
 * lead's spec in design language v2 §10.5: §6 check rows, one per optional control in the
 * bar's order, each leading with the control's glyph after the box, "Hidden at this width." on
 * a pinned control the width tier folded, Done alone in the footer – and the "Reset to
 * default" row. All three are the desktop's (`layouts: ['desktop']`); the switch and the
 * dialog's Forward row are one setting, `toolbarPins.forward`.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { buildSection } = await import('../sections')
const { findRow } = await import('../model')
const { DialogStack } = await import('../dialogs')
const { DOWNLOADS_UNCHECKED, HIDDEN_AT_THIS_WIDTH } = await import('../CustomizeToolbarForm')

type Ctx = Parameters<typeof buildSection>[1]
type Row = NonNullable<ReturnType<typeof findRow>>
type RowGroups = ReturnType<typeof buildSection>['groups']

const LOOK = INTERNAL_PAGES.settings.sections.find((s) => s.id === 'look')!

const SITE: Tab = { id: 'site', url: 'https://example.com/a', title: 'A', openerTabId: null } as Tab
const SETTINGS_TAB: Tab = {
  id: 'settings',
  url: 'zen://settings/look',
  title: 'Settings',
  openerTabId: 'site'
} as Tab

function state(settings: Partial<Settings> = {}): UIState {
  return {
    platform: 'linux',
    capabilities: { windows: true, windowControls: true, pageControls: false },
    version: '0.4.27-test',
    tabs: { site: SITE, settings: SETTINGS_TAB },
    essentialTabIds: [],
    spaces: [
      { id: 'space', name: 'Personal', activeTabId: 'settings', tabIds: ['site', 'settings'] }
    ],
    activeSpaceId: 'space',
    containers: DEFAULT_CONTAINERS,
    folders: {},
    splitGroups: {},
    settings: { ...DEFAULT_SETTINGS, ...settings },
    shortcuts: defaultShortcuts('linux', 'chrome'),
    searchEngines: DEFAULT_SEARCH_ENGINES,
    glance: null,
    compactSidebarRevealed: false,
    window: { id: 'w', kind: 'main', maximized: false, fullscreen: false, focused: true },
    downloads: [],
    bookmarks: [],
    media: [],
    resources: emptyResourceSnapshot(),
    boosts: [],
    extensions: [],
    mods: [],
    agents: [],
    agentServer: emptyAgentServerStatus(),
    updates: emptyUpdateStatus('0.4.27-test', { os: 'linux', arch: 'x64', kind: 'appimage' }),
    passwords: emptyPasswordsStatus(),
    autofill: emptyAutofillUIState(),
    blocking: emptyBlockingStatus(),
    privacy: emptyPrivacyStatus(),
    pageEnvironment: DEFAULT_PAGE_ENVIRONMENT,
    siteData: emptySiteDataStatus(),
    translate: { available: true, tabs: {} },
    spellcheck: UNAVAILABLE_SPELLCHECK
  } as unknown as UIState
}

function look(
  s: UIState,
  formFactor: FormFactor = 'desktop'
): { groups: RowGroups; patches: Partial<Settings>[] } {
  const patches: Partial<Settings>[] = []
  const ctx = {
    state: s,
    tab: SETTINGS_TAB,
    pointer: true,
    formFactor,
    set: (patch: Partial<Settings>) => patches.push(patch),
    navigate: () => undefined,
    openBarEditor: () => undefined,
    localFonts: [],
    fontsDraft: null
  } as unknown as Ctx
  return { groups: buildSection(LOOK, ctx).groups, patches }
}

function row(groups: RowGroups, id: string): Row {
  const found = findRow(groups, id)
  if (!found) throw new Error(`no row ${id}`)
  return found
}

let root: Root | null = null
let host: HTMLElement | null = null

function render(element: ReactElement): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root?.render(element))
  return host
}

/** The Customise toolbar dialog over the real Look and Feel groups. */
function openDialog(
  s: UIState,
  closeTop = vi.fn()
): { h: HTMLElement; patches: Partial<Settings>[]; closeTop: ReturnType<typeof vi.fn> } {
  const { groups, patches } = look(s)
  const h = render(
    <FrameDialogHost>
      <DialogStack
        requests={[{ kind: 'form', rowId: 'customize-toolbar' }]}
        groups={groups}
        ctx={{ open: () => undefined }}
        closeTop={closeTop}
      />
    </FrameDialogHost>
  )
  return { h, patches, closeTop }
}

function controlRows(h: HTMLElement): HTMLLabelElement[] {
  return [...h.querySelectorAll<HTMLLabelElement>('[data-row^="toolbar-control:"]')]
}

function box(h: HTMLElement, control: string): HTMLInputElement {
  return h.querySelector<HTMLInputElement>(
    `[data-row="toolbar-control:${control}"] input[type="checkbox"]`
  )!
}

beforeEach(() => toolbarTiering.set({ hidden: [] }))

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

describe('Look and Feel › the toolbar rows (settings-36)', () => {
  it('stand under the Layout cards in the Appearance group, on the desktop alone', () => {
    const { groups } = look(state())
    const appearance = groups.find((g) => g.id === 'appearance')!
    const ids = appearance.rows.map((r) => r.id)
    const layout = ids.indexOf('toolbar-layout')
    // The default bar: the switch and the dialog's row; Reset has nothing to undo and is not drawn.
    expect(ids.slice(layout, layout + 4)).toEqual([
      'toolbar-layout',
      'show-forward-button',
      'customize-toolbar',
      'tabs-right'
    ])
    for (const id of ['show-forward-button', 'customize-toolbar']) {
      expect(row(groups, id).layouts).toEqual(['desktop'])
    }
    // With a control folded, Reset takes the row after the dialog's.
    const folded = look(state({ toolbarPins: { star: false } })).groups
    const foldedIds = folded.find((g) => g.id === 'appearance')!.rows.map((r) => r.id)
    expect(foldedIds.slice(layout, layout + 5)).toEqual([
      'toolbar-layout',
      'show-forward-button',
      'customize-toolbar',
      'toolbar-reset',
      'tabs-right'
    ])
    expect(row(folded, 'toolbar-reset').layouts).toEqual(['desktop'])
    for (const formFactor of ['phone', 'tablet'] as const) {
      const other = look(state({ toolbarPins: { star: false } }), formFactor).groups
      for (const id of ['show-forward-button', 'customize-toolbar', 'toolbar-reset'])
        expect(findRow(other, id), `${id} on the ${formFactor}`).toBeNull()
    }
  })

  it('"Show forward button" is Forward’s pin: checked while the key is absent, writing the fold and the un-fold', () => {
    const { groups, patches } = look(state())
    const forward = row(groups, 'show-forward-button')
    expect(forward).toMatchObject({ kind: 'switch', label: 'Show forward button', checked: true })
    if (forward.kind !== 'switch') throw new Error('not a switch')
    forward.onChange(false)
    expect(patches).toEqual([{ toolbarPins: { forward: false } }])
    const folded = look(state({ toolbarPins: { forward: false, star: false } }))
    const off = row(folded.groups, 'show-forward-button')
    expect(off).toMatchObject({ checked: false })
    if (off.kind !== 'switch') throw new Error('not a switch')
    off.onChange(true)
    // Re-pinning removes the key and leaves the other fold alone.
    expect(folded.patches).toEqual([{ toolbarPins: { star: false } }])
  })

  it('"Customise toolbar" is a button row opening the 400 form dialog with the lead’s title block (§9.20); British spelling on every surface, the id and the search keywords carrying both', () => {
    const { groups } = look(state())
    const customize = row(groups, 'customize-toolbar')
    expect(customize).toMatchObject({
      kind: 'action',
      label: 'Customise toolbar',
      button: 'Customise…',
      form: {
        title: 'Customise toolbar',
        description: 'Choose the controls beside the address bar and how they show.',
        body: 'list'
      }
    })
    expect(customize.keywords).toEqual(
      expect.arrayContaining(['customise toolbar', 'customize toolbar'])
    )
    const { h } = openDialog(state())
    const dialog = h.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.getAttribute('data-dialog')).toBe('form:customize-toolbar')
    expect(dialog.textContent).toContain('Customise toolbar')
    expect(dialog.textContent).not.toContain('Customize')
    expect(dialog.textContent).toContain(
      'Choose the controls beside the address bar and how they show.'
    )
  })

  it('"Reset to default" is not drawn while the bar is the default – never a disabled row on the first screen (§10.4, #297) – and, once something differs, undoes every fold and the downloads key at once', () => {
    const { groups } = look(state())
    expect(findRow(groups, 'toolbar-reset')).toBeNull()
    // The default bar by way of an explicit key: still nothing to reset, still no row.
    expect(
      findRow(
        look(state({ downloads: { ...DEFAULT_SETTINGS.downloads, alwaysShowButton: false } }))
          .groups,
        'toolbar-reset'
      )
    ).toBeNull()
    const changed = look(
      state({
        toolbarPins: { forward: false, media: false },
        downloads: { ...DEFAULT_SETTINGS.downloads, alwaysShowButton: true }
      })
    )
    const reset = row(changed.groups, 'toolbar-reset')
    expect(reset).toMatchObject({
      kind: 'action',
      button: 'Reset to default',
      description: '3 controls differ from the default bar.'
    })
    if (reset.kind !== 'action') throw new Error('not an action')
    // Live, not dependent: the row is there because there is something to do.
    expect(reset.disabled).toBeFalsy()
    reset.onPress?.()
    expect(changed.patches).toEqual([{ toolbarPins: {}, downloads: { alwaysShowButton: false } }])
    const one = look(state({ toolbarPins: { star: false } }))
    expect(row(one.groups, 'toolbar-reset')).toMatchObject({
      description: '1 control differs from the default bar.'
    })
    // The downloads key alone counts as a departure the row can undo.
    const key = look(
      state({ downloads: { ...DEFAULT_SETTINGS.downloads, alwaysShowButton: true } })
    )
    expect(row(key.groups, 'toolbar-reset')).toMatchObject({
      description: '1 control differs from the default bar.'
    })
  })
})

describe('the Customise toolbar dialog (the lead’s spec, §10.5)', () => {
  it('lists the optional controls as check rows in the bar’s order, each with its glyph after the box and no row for the bar itself', () => {
    const { h } = openDialog(state())
    const rows = controlRows(h)
    expect(rows.map((r) => r.dataset.row)).toEqual([
      'toolbar-control:forward',
      'toolbar-control:reader',
      'toolbar-control:translate',
      'toolbar-control:star',
      'toolbar-control:media',
      'toolbar-control:downloads'
    ])
    expect(rows.map((r) => r.querySelector('.zen-settings-label')?.textContent)).toEqual([
      'Forward',
      'Reader View',
      'Translate',
      'Bookmark this page',
      'Media',
      'Downloads'
    ])
    for (const r of rows) {
      // The chassis's check row: the row is the box's label, the box first, the glyph in the
      // leading slot after it, then the text.
      expect(r.tagName).toBe('LABEL')
      expect(r.className.split(' ')).toEqual(
        expect.arrayContaining(['zen-settings-row', 'zen-settings-check-row', 'zen-v2-check-row'])
      )
      const children = [...r.children]
      expect(children[0]).toMatchObject({ tagName: 'INPUT', className: 'zen-v2-checkbox' })
      expect(children[1].className).toBe('zen-settings-leading')
      expect(children[1].querySelector('svg')).not.toBeNull()
      expect(children[2].className).toBe('zen-settings-row-text')
      // Chrome's words for the two states are not drawn.
      expect(r.textContent).not.toMatch(/\bpin\b|\bunpin\b/i)
    }
    const text = h.querySelector('[role="dialog"]')!.textContent ?? ''
    for (const never of ['Back', 'Reload', 'Address', 'Menu'])
      expect(text.includes(never), never).toBe(false)
  })

  it('checked is in the bar: the default bar has every box checked but Downloads, whose key is the downloads block’s', () => {
    const { h } = openDialog(state())
    for (const control of ['forward', 'reader', 'translate', 'star', 'media'])
      expect(box(h, control).checked, control).toBe(true)
    expect(box(h, 'downloads').checked).toBe(false)
    act(() => root?.unmount())
    host?.remove()
    const folded = openDialog(
      state({
        toolbarPins: { reader: false, media: false },
        downloads: { ...DEFAULT_SETTINGS.downloads, alwaysShowButton: true }
      })
    )
    expect(box(folded.h, 'reader').checked).toBe(false)
    expect(box(folded.h, 'media').checked).toBe(false)
    expect(box(folded.h, 'forward').checked).toBe(true)
    expect(box(folded.h, 'downloads').checked).toBe(true)
  })

  it('a box writes its pin as it is toggled – no preview, nothing held for Done – and Downloads writes the downloads key', () => {
    const { h, patches } = openDialog(state({ toolbarPins: { star: false } }))
    act(() => box(h, 'forward').click())
    expect(patches.at(-1)).toEqual({ toolbarPins: { star: false, forward: false } })
    act(() => box(h, 'star').click())
    expect(patches.at(-1)).toEqual({ toolbarPins: {} })
    act(() => box(h, 'downloads').click())
    expect(patches.at(-1)).toEqual({ downloads: { alwaysShowButton: true } })
  })

  it('every row keeps its lines across its two states, so a toggle never moves the rows under the pointer (§9.2)', () => {
    const lines = (h: HTMLElement): Record<string, string | null> =>
      Object.fromEntries(
        controlRows(h).map((r) => [
          r.dataset.row!.split(':')[1],
          r.querySelector('.zen-settings-description')?.textContent ?? null
        ])
      )
    // The default bar: Downloads unchecked, the others checked.
    const rest = openDialog(state())
    const atRest = lines(rest.h)
    expect(atRest).toEqual({
      forward: null,
      reader: 'Shows on pages with an article.',
      translate: null,
      star: null,
      media: 'Shows while media plays.',
      downloads: DOWNLOADS_UNCHECKED
    })
    act(() => root?.unmount())
    host?.remove()
    // Every box the other way: the same lines, row for row.
    const flipped = openDialog(
      state({
        toolbarPins: { forward: false, reader: false, translate: false, star: false, media: false },
        downloads: { ...DEFAULT_SETTINGS.downloads, alwaysShowButton: true }
      })
    )
    expect(lines(flipped.h)).toEqual(atRest)
    act(() => root?.unmount())
    host?.remove()
    // One convention per list (§9.1): every line the rows can carry is a sentence with its
    // full stop – the width line, on the pinned controls the tier has folded, included.
    const narrow = openDialog(state())
    act(() => toolbarTiering.set({ hidden: ['forward', 'reader', 'translate', 'star', 'media'] }))
    const atWidth = lines(narrow.h)
    expect(atWidth.forward).toBe(HIDDEN_AT_THIS_WIDTH)
    expect(atWidth.downloads).toBe(DOWNLOADS_UNCHECKED)
    for (const line of [...Object.values(atWidth), ...Object.values(atRest)]) {
      if (line !== null) expect(line, line).toMatch(/[a-z]\.$/)
    }
  })

  it('a pinned control the width tier hid says "Hidden at this width." and stays checked and live; a folded one says nothing of the width', () => {
    const { h } = openDialog(state({ toolbarPins: { star: false } }))
    const description = (control: string): string | null =>
      h.querySelector(`[data-row="toolbar-control:${control}"] .zen-settings-description`)
        ?.textContent ?? null
    expect(description('translate')).toBeNull()
    act(() => toolbarTiering.set({ hidden: ['translate', 'star', 'media'] }))
    expect(description('translate')).toBe(HIDDEN_AT_THIS_WIDTH)
    expect(box(h, 'translate').checked).toBe(true)
    expect(box(h, 'translate').disabled).toBe(false)
    expect(
      h.querySelector('[data-row="toolbar-control:translate"]')!.getAttribute('aria-disabled')
    ).toBeNull()
    // The hub's row keeps its own line while it plays and the tier has folded it.
    expect(description('media')).toBe(HIDDEN_AT_THIS_WIDTH)
    // The star is folded by its pin, not the width: unchecked, no width line.
    expect(box(h, 'star').checked).toBe(false)
    expect(description('star')).toBeNull()
    act(() => toolbarTiering.set({ hidden: [] }))
    expect(description('translate')).toBeNull()
    expect(description('media')).toBe('Shows while media plays.')
  })

  it('the footer is Done alone – a secondary, no Cancel – and Done closes the dialog', () => {
    const { h, closeTop } = openDialog(state())
    const footer = h.querySelector<HTMLElement>('.zen-settings-dialog-footer')!
    expect(footer).not.toBeNull()
    const buttons = [...footer.querySelectorAll<HTMLButtonElement>('button')]
    expect(buttons.map((b) => b.textContent)).toEqual(['Done'])
    expect(buttons[0].className.split(' ')).toContain('zen-v2-button')
    expect(buttons[0].hasAttribute('data-primary')).toBe(false)
    expect(
      [...h.querySelectorAll('[role="dialog"] button')].map((b) => b.textContent)
    ).not.toContain('Cancel')
    act(() => buttons[0].click())
    expect(closeTop).toHaveBeenCalledTimes(1)
  })
})
