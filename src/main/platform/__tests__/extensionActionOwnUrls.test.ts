import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Tab } from '../../../shared/types'
import type { ZenWindow } from '../../../core/window'
import { ActionApi } from '../extensionApi/action'
import type { ApiContext, ApiHost, LoadedExtension } from '../extensionApi/types'

const EXT = 'pbanhockgagggenencehbnadejlgchfc'
const OTHER = 'mmeijimgabbpbgpdklnllpncmdofkcpn'
/** The per-session origin Chromium's `runtime.getURL` answers for a `use_dynamic_url` path. */
const GUID = 'e4ef1c37-3daf-421b-aa31-86ab8bbd94d0'

interface World {
  api: ActionApi
  ctx: ApiContext
  commits: number
}

function world(path: string): World {
  const win = { id: 'w1' } as unknown as ZenWindow
  const tab = { id: 't1', url: 'https://example.com/' } as unknown as Tab
  const ext = {
    id: EXT,
    path,
    manifest: {
      manifest_version: 3,
      name: 'Probe',
      version: '1.0',
      action: { default_icon: { 16: 'assets/icons/favicon-16.png' } }
    }
  } as unknown as LoadedExtension
  const state: World = {
    api: undefined as unknown as ActionApi,
    ctx: undefined as unknown as ApiContext,
    commits: 0
  }
  const host = {
    model: {
      zenWindow: () => win,
      lastFocusedWindow: () => win,
      chromeTabId: () => 7,
      zenTab: () => tab,
      popupForTabId: () => undefined
    },
    browser: { tabs: { activeTabFor: () => tab }, extensions: { popupOpen: () => false } },
    loaded: () => ext,
    commitUi: () => {
      state.commits += 1
    }
  } as unknown as ApiHost
  state.api = new ActionApi(host)
  state.ctx = {
    extensionId: EXT,
    extension: ext,
    sender: { kind: 'worker' },
    window: undefined
  } as unknown as ApiContext
  return state
}

// A 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

describe("action.setIcon / setPopup with the URLs the extension's own runtime.getURL answers", () => {
  let dir: string
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('setIcon takes a dictionary of dynamic-origin URLs, as Chrome loads them (Simplify Copilot)', () => {
    dir = mkdtempSync(join(tmpdir(), 'zen-own-resource-'))
    const icons = join(dir, 'assets', 'icons')
    mkdirSync(icons, { recursive: true })
    writeFileSync(join(icons, 'favicon-16.png'), PNG)
    writeFileSync(join(icons, 'favicon-32.png'), PNG)
    const w = world(dir)
    const dynamic = (file: string): string => `chrome-extension://${GUID}/assets/icons/${file}`
    expect(() =>
      w.api.handlers.setIcon(w.ctx, {
        path: { 16: dynamic('favicon-16.png'), 32: dynamic('favicon-32.png') },
        tabId: 7
      })
    ).not.toThrow()
    expect(() => w.api.handlers.setIcon(w.ctx, { path: dynamic('favicon-32.png') })).not.toThrow()
    expect(w.api.stateFor(EXT)?.icon).toMatch(/^data:image\/png;base64,/)
    // A file the package has not got is still refused, and so is another extension's origin.
    expect(() => w.api.handlers.setIcon(w.ctx, { path: dynamic('nope.png') })).toThrow(
      'Could not load action icon.'
    )
    expect(() =>
      w.api.handlers.setIcon(w.ctx, {
        path: `chrome-extension://${OTHER}/assets/icons/favicon-16.png`
      })
    ).toThrow('Could not load action icon.')
  })

  it('setPopup takes the static URL and a path, and refuses the dynamic URL as Chrome does', () => {
    dir = mkdtempSync(join(tmpdir(), 'zen-own-resource-'))
    const w = world(dir)
    w.api.handlers.setPopup(w.ctx, { popup: `chrome-extension://${EXT}/popup.html` })
    expect(w.api.handlers.getPopup(w.ctx, {})).toBe(`chrome-extension://${EXT}/popup.html`)
    w.api.handlers.setPopup(w.ctx, { popup: '/panel/index.html' })
    expect(w.api.handlers.getPopup(w.ctx, {})).toBe(`chrome-extension://${EXT}/panel/index.html`)
    expect(() =>
      w.api.handlers.setPopup(w.ctx, { popup: `chrome-extension://${GUID}/popup.html` })
    ).toThrow(
      'The specified popup path is invalid. Ensure it is a path to a file in this extension.'
    )
    expect(w.api.handlers.getPopup(w.ctx, {})).toBe(`chrome-extension://${EXT}/panel/index.html`)
  })
})
