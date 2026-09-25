import { describe, expect, it } from 'vitest'
import { SidePanelApi } from '../extensionApi/sidePanel'
import type { PanelViewHost } from '../extensionApi/sidePanelBridge'
import type { ApiContext, ApiHost, LoadedExtension } from '../extensionApi/types'

const EXT = 'kjchkpkjpiloipaonppkmepcbhcncedo'
const OTHER = 'abcdefghijklmnopabcdefghijklmnop'

function world(): { api: SidePanelApi; ctx: ApiContext } {
  const ext = {
    id: EXT,
    path: '/ext/' + EXT,
    manifest: { name: 'Probe', side_panel: { default_path: 'sidepanel.html' } },
    sessions: [{}]
  } as unknown as LoadedExtension
  const host = {
    grants: () => ({ permissions: ['sidePanel'], origins: [] }),
    store: { sidePanelOnActionClick: () => false, setSidePanelOnActionClick: () => undefined },
    model: { zenTab: () => undefined },
    commitUi: () => undefined,
    browser: { allWindows: () => [] }
  } as unknown as ApiHost
  const views = { create: () => null } as unknown as PanelViewHost
  const api = new SidePanelApi(host, views)
  api.load(ext)
  const ctx = {
    extensionId: EXT,
    extension: ext,
    sender: { kind: 'worker' }
  } as unknown as ApiContext
  return { api, ctx }
}

describe('sidePanel.setOptions on the desktop', () => {
  it("takes the extension's own absolute URL as its path, as Chrome does (Adobe Photoshop's runtime.getURL('/sidepanel.html'))", () => {
    const { api, ctx } = world()
    api.handlers.setOptions(ctx, {
      enabled: true,
      path: `chrome-extension://${EXT}/sidepanel.html?from=worker#top`
    })
    expect(api.handlers.getOptions(ctx, {})).toEqual({
      enabled: true,
      path: 'sidepanel.html?from=worker#top'
    })
  })

  it("still refuses another extension's URL and a site URL", () => {
    const { api, ctx } = world()
    for (const path of [
      `chrome-extension://${OTHER}/sidepanel.html`,
      'https://example.com/p.html'
    ]) {
      expect(() => api.handlers.setOptions(ctx, { path })).toThrow('Invalid options')
    }
    expect(api.handlers.getOptions(ctx, {})).toEqual({ enabled: true, path: 'sidepanel.html' })
  })
})
