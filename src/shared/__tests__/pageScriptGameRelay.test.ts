// @vitest-environment happy-dom
// @vitest-environment-options { "url": "zen://game" }
import { describe, expect, it } from 'vitest'
import { installPageScript, type PageScriptMessage, type PageScriptTransport } from '../pageScript'
import { GAME_MESSAGE_KEY, gameWindowMessage } from '../game/bridge'

/**
 * The page script on a document of Zenium's own scheme (`zen://game` here; the no-connection page
 * is the other): Roll's runtime posts on its window, the script relays the ask and the report to
 * the core as `game` page messages, and nothing else the window hears. The messages are
 * dispatched with their source set by hand: under vitest the global `window` the script compares
 * against is the environment's, not the happy-dom window `postMessage` would name.
 */
function install(): PageScriptMessage[] {
  const sent: PageScriptMessage[] = []
  const transport: PageScriptTransport = {
    send: (m) => {
      sent.push(m)
    },
    onFlags: () => undefined,
    reportBlockedPopups: false
  }
  installPageScript(transport)
  return sent
}

function hear(data: unknown, source: Window | null = window): void {
  window.dispatchEvent(
    new MessageEvent('message', { data, source: source as MessageEventSource | null })
  )
}

const games = (sent: PageScriptMessage[]): PageScriptMessage[] =>
  sent.filter((m) => m.type === 'game')

describe("the page script's relay for Roll (ERR-03, §9.17 (i))", () => {
  it("relays the runtime's ask and report from its own window, sanitised, and nothing else", () => {
    expect(location.protocol).toBe('zen:')
    const sent = install()
    hear(gameWindowMessage({ ask: 'best' }))
    hear(gameWindowMessage({ best: 42.9 }))
    hear({ zeniumInterstitial: { action: 'back' } })
    hear({ [GAME_MESSAGE_KEY]: 'mount' })
    hear({ [GAME_MESSAGE_KEY]: { ask: 'everything' } })
    hear('zeniumGame')
    hear(null)
    expect(games(sent)).toEqual([
      { type: 'game', game: { ask: 'best' } },
      { type: 'game', game: { best: 42 } }
    ])
  })

  it('ignores a message from another window', () => {
    const sent = install()
    hear(gameWindowMessage({ ask: 'best' }), null)
    hear(gameWindowMessage({ best: 7 }))
    expect(games(sent)).toEqual([{ type: 'game', game: { best: 7 } }])
  })
})
