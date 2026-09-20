import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../shared/types'
import type { ZenWindow } from '../../window'
import { ActionApi } from '../../../main/platform/extensionApi/action'
import type {
  ApiContext,
  ApiHost,
  LoadedExtension
} from '../../../main/platform/extensionApi/types'

const EXT = 'mmeijimgabbpbgpdklnllpncmdofkcpn'

interface World {
  api: ActionApi
  ctx: ApiContext
  opened: string[]
  popupOpen: boolean
}

function world(popup = 'initializer.html'): World {
  const win = { id: 'w1' } as unknown as ZenWindow
  const tab = { id: 't1', url: 'https://example.com/' } as unknown as Tab
  const ext = {
    id: EXT,
    manifest: {
      manifest_version: 3,
      name: 'Probe',
      version: '1.0',
      action: { default_popup: popup }
    }
  } as unknown as LoadedExtension
  const state: World = {
    api: undefined as unknown as ActionApi,
    ctx: undefined as unknown as ApiContext,
    opened: [],
    popupOpen: false
  }
  const host = {
    model: {
      zenWindow: (id: number) => (id === 1 ? win : undefined),
      lastFocusedWindow: () => win,
      chromeTabId: () => 7,
      zenTab: () => tab,
      popupForTabId: () => undefined
    },
    browser: {
      tabs: { activeTabFor: () => tab },
      extensions: { popupOpen: () => state.popupOpen }
    },
    loaded: () => ext,
    openPopup: (extensionId: string) => {
      state.opened.push(extensionId)
      state.popupOpen = true
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

describe('action.openPopup', () => {
  it('opens the popup once, and refuses while one shows, as Chrome does', () => {
    const w = world()
    expect(w.api.handlers.openPopup(w.ctx, undefined)).toBeUndefined()
    expect(w.opened).toEqual([EXT])
    // The popup's own document messages the worker, whose handler calls openPopup again
    // (Screencastify signed out): Chrome's toolbar does not replace the popup that is up.
    expect(() => w.api.handlers.openPopup(w.ctx, {})).toThrow('Failed to open popup.')
    expect(w.opened).toEqual([EXT])
    // Closed (by the user, or the document's window.close()): the next call opens again.
    w.popupOpen = false
    expect(w.api.handlers.openPopup(w.ctx, { windowId: 1 })).toBeUndefined()
    expect(w.opened).toEqual([EXT, EXT])
  })

  it("keeps Chrome's other answers ahead of the popup check", () => {
    const w = world('')
    w.popupOpen = true
    expect(() => w.api.handlers.openPopup(w.ctx, undefined)).toThrow(
      'Extension has no popup on the active tab.'
    )
    const withPopup = world()
    withPopup.popupOpen = true
    expect(() => withPopup.api.handlers.openPopup(withPopup.ctx, { windowId: 9 })).toThrow(
      'No window with id: 9.'
    )
  })
})
