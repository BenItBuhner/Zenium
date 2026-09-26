// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { UIState } from '@shared/types'
import { emptyUpdateStatus, type UpdateStatus } from '@shared/updates'

/*
 * The dot on the bar's Menu button while an update is downloaded and waiting (TB-12): the 6 px
 * accent dot the desktop's ⋯ wears (`SidebarTop`, shortcuts-menus-101), Chrome's badge on its
 * ⋮ for the "Update Chrome" row – on the phone's ⋯ for the 'ready' phase alone, at the glyph's
 * corner, the button's name saying it for the tree; nothing for the other phases.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })

const { BarButton } = await import('../BarButton')
const { BAR_ITEMS } = await import('../barItems')

function state(phase: UpdateStatus['phase']): UIState {
  const updates: UpdateStatus = {
    ...emptyUpdateStatus('1.2.3', { os: 'android', arch: 'arm64', kind: 'apk' }),
    phase,
    downloadedPath: phase === 'ready' ? '/data/zenium-2.0.0.apk' : null
  }
  return {
    platform: 'android',
    capabilities: { share: true, updates: true },
    tabs: {},
    spaces: [],
    activeSpaceId: 'space',
    settings: { ...DEFAULT_SETTINGS },
    updates
  } as unknown as UIState
}

let root: Root | null = null
let mount: HTMLElement | null = null

function render(phase: UpdateStatus['phase']): HTMLButtonElement {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => {
    root!.render(
      <BarButton id="menu" ctx={{ state: state(phase), tab: null, overviewOpen: false }} />
    )
  })
  return mount.querySelector('button')!
}

afterEach(() => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
})

describe('the update dot on the bar’s Menu button (TB-12)', () => {
  it('wears the accent dot at the ⋯ glyph’s corner and says so in its name while the update is downloaded and waiting', () => {
    const button = render('ready')
    expect(button.getAttribute('aria-label')).toBe('Menu, update ready')
    const dot = button.querySelector('[data-testid="update-ready-dot"]')!
    expect(dot).not.toBeNull()
    expect(dot.classList.contains('zen-mhub-dot')).toBe(true)
    expect(dot.getAttribute('aria-hidden')).toBe('true')
    // The glyph is the dot's box (`.zen-glyph-dot`), so the dot sits against the glyph's corner
    // in the 44 button as it does in the desktop's 28.
    expect(dot.parentElement?.classList.contains('zen-glyph-dot')).toBe(true)
    expect(dot.parentElement?.querySelector('svg')).not.toBeNull()
    // Not a state of the button: no pressed flag, still the Menu.
    expect(button.getAttribute('aria-pressed')).toBeNull()
    expect(button.getAttribute('data-bar-item')).toBe('menu')
  })

  it('wears nothing – and is plain "Menu" – while an update is idle, being checked for, merely found, downloading, up to date or failed', () => {
    for (const phase of [
      'idle',
      'checking',
      'up-to-date',
      'available',
      'downloading',
      'error'
    ] as const) {
      const button = render(phase)
      expect(button.getAttribute('aria-label'), phase).toBe('Menu')
      expect(button.querySelector('[data-testid="update-ready-dot"]'), phase).toBeNull()
      expect(button.querySelector('.zen-mhub-dot'), phase).toBeNull()
      expect(button.querySelector('svg'), phase).not.toBeNull()
      act(() => root?.unmount())
      mount?.remove()
    }
  })

  it('the editor names the item Menu whatever the phase: the dot is the bar’s, the name the tree’s', () => {
    expect(BAR_ITEMS.menu.label).toBe('Menu')
    expect(BAR_ITEMS.menu.name?.({ state: state('ready'), tab: null, overviewOpen: false })).toBe(
      'Menu, update ready'
    )
    expect(BAR_ITEMS.menu.name?.({ state: state('idle'), tab: null, overviewOpen: false })).toBe(
      'Menu'
    )
  })

  it('seats the dot against the glyph in the stylesheet: 2 out from the glyph’s box on the phone, 8 in on the tablet’s 40 button', () => {
    const css = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8')
    const phone = css.match(/\.zen-glyph-dot > \.zen-mhub-dot \{([^}]*)\}/)
    expect(phone?.[1]).toMatch(/top:\s*-2px/)
    expect(phone?.[1]).toMatch(/right:\s*-2px/)
    const tablet = css.match(
      /:root\[data-form-factor='tablet'\] \.zen-tablet-toolbar \.zen-mhub-dot \{([^}]*)\}/
    )
    expect(tablet?.[1]).toMatch(/top:\s*8px/)
    expect(tablet?.[1]).toMatch(/right:\s*8px/)
    // The dot itself is unchanged: 6 px, the accent, the desktop's 4 in.
    const dot = css.match(/\n {2}\.zen-mhub-dot \{([^}]*)\}/)
    expect(dot?.[1]).toMatch(/width:\s*6px/)
    expect(dot?.[1]).toMatch(/background:\s*var\(--zen-accent\)/)
    expect(dot?.[1]).toMatch(/top:\s*4px/)
  })
})
