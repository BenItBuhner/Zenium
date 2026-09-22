// @vitest-environment happy-dom
import type { BootGroup, ContentBootConfig, ExtensionBoot } from '@core/extensions/runtime/boot'
import { describe, expect, it } from 'vitest'

/*
 * A CSS content script's text as the frame injects it: the manifest's `css` files and the files
 * of `scripting.insertCSS` localized as Chrome localizes them (`__MSG_@@extension_id__`, the
 * extension's own messages), an inline `css` string injected as written. One boot for the file,
 * under the `with` fallback, the sheet read back from the document's constructed stylesheets.
 */

interface Boot {
  config: ContentBootConfig
  sources: Record<string, unknown>
  css: Record<string, string>
}

type Exec = (
  token: unknown,
  extId: unknown,
  kind: unknown,
  payload: unknown,
  fn: unknown
) => unknown

interface Bridge {
  postMessage(message: string): void
  onmessage: ((event: { data: string }) => void) | null
}

const TOKEN = 'css-test-token'
const EXT = 'cmeakgjggjdlcpncigglobpjbkabhmjl'

const group = (): BootGroup => ({
  index: 0,
  runAt: 'document_start',
  world: 'ISOLATED',
  matches: ['<all_urls>'],
  excludeMatches: [],
  includeGlobs: [],
  excludeGlobs: [],
  allFrames: true,
  matchAboutBlank: false,
  matchOriginAsFallback: false,
  js: [],
  css: ['css/sih.css']
})

const extension = (): ExtensionBoot => ({
  id: EXT,
  name: 'Steam Inventory Helper',
  version: '1.0',
  manifestVersion: 3,
  permissions: ['storage', 'scripting'],
  optionalPermissions: [],
  hostPermissions: ['<all_urls>'],
  manifest: { manifest_version: 3, name: 'Steam Inventory Helper', version: '1.0' },
  messages: { accent: { message: '#66c0f4' } },
  groups: [group()],
  isolation: 'with'
})

/** The text of every sheet the frame adopted, in order. */
function adoptedTexts(): string[] {
  return document.adoptedStyleSheets.map((sheet) =>
    Array.from(sheet.cssRules)
      .map((rule) => rule.cssText)
      .join('')
  )
}

describe('content bootstrap: CSS content scripts', () => {
  it("substitutes __MSG_ placeholders in the manifest's sheets and in insertCSS files, not in an inline string", async () => {
    const bridge: Bridge = { postMessage: () => undefined, onmessage: null }
    const g = globalThis as typeof globalThis & {
      __zenExtBridge?: Bridge
      __zenExtBoot?: Boot
      __zenExtExec?: Exec
    }
    g.__zenExtBridge = bridge
    g.__zenExtBoot = {
      config: {
        kind: 'content',
        token: TOKEN,
        uiLanguage: 'en-US',
        world: 'isolated',
        extension: extension()
      },
      sources: {},
      css: {
        [`${EXT}/css/sih.css`]:
          '.sih-icon{background-image:url(chrome-extension://__MSG_@@extension_id__/img/icon.png);color:__MSG_accent__}'
      }
    }
    await import('../extensionBootstrap')
    const exec = g.__zenExtExec
    expect(exec).toBeTypeOf('function')
    if (!exec) return

    // The manifest sheet, adopted at document start with the id and the message in place.
    const manifestSheet = adoptedTexts().join('\n')
    expect(manifestSheet).toContain(`chrome-extension://${EXT}/img/icon.png`)
    expect(manifestSheet).toContain('#66c0f4')
    expect(manifestSheet).not.toContain('__MSG_')

    // `scripting.insertCSS({ files })`: the host reads the file and marks it as one.
    exec(
      TOKEN,
      EXT,
      'css',
      {
        id: 'css/panel.css',
        code: '.sih-panel{background:url("chrome-extension://__MSG_@@extension_id__/img/bg.png")}',
        file: true
      },
      null
    )
    const before = adoptedTexts().length
    expect(adoptedTexts().join('\n')).toContain(`chrome-extension://${EXT}/img/bg.png`)

    // `scripting.insertCSS({ css })`: an inline string is Chrome's as written.
    const inline = '.sih-inline{--id:"__MSG_@@extension_id__"}'
    exec(TOKEN, EXT, 'css', { id: inline, code: inline }, null)
    expect(adoptedTexts().length).toBe(before + 1)
    expect(adoptedTexts().at(-1)).toContain('__MSG_@@extension_id__')

    // `removeCSS` of the file takes the localized sheet out by the same id.
    exec(TOKEN, EXT, 'css', { id: 'css/panel.css', code: '', remove: true, file: true }, null)
    expect(adoptedTexts().join('\n')).not.toContain('img/bg.png')
  })
})
