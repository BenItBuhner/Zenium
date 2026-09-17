import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { RuleEngine } from '../../../core/blocking/engine'
import { engineSetId, type EngineRuleSet } from '../../../core/extensions/dnr/sink'
import { createDnrSink } from '../extensionApi/dnrSink'
import {
  EXTENSION_RESOURCE_SCHEME,
  ExtensionResourceOrigin,
  type ServedExtension
} from '../extensionApi/resourceOrigin'

const ID = 'abcdefghijklmnopabcdefghijklmnop'
const OTHER = 'ponmlkjihgfedcbaponmlkjihgfedcba'
const TOKEN = '0123456789abcdef0123456789abcdef'

const dir = mkdtempSync(join(tmpdir(), 'zen-war-'))
mkdirSync(join(dir, 'war'))
writeFileSync(join(dir, 'war', 'noop.js'), 'window.noop = 1\n')
writeFileSync(join(dir, 'war', 'blank.gif'), Buffer.from([0x47, 0x49, 0x46]))
mkdirSync(join(dir, 'plain'))
writeFileSync(join(dir, 'plain', 'ok.js'), 'window.ok = 1\n')
writeFileSync(join(dir, 'secret.json'), '{"key":"x"}')
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const served: ServedExtension = {
  path: dir,
  manifest: {
    web_accessible_resources: [
      { resources: ['war/*'], matches: ['<all_urls>'], use_dynamic_url: true },
      { resources: ['plain/*'], matches: ['<all_urls>'] }
    ]
  }
}
const origin = new ExtensionResourceOrigin((id) => (id === ID ? served : undefined), TOKEN)
const base = `${EXTENSION_RESOURCE_SCHEME}://${ID}.${TOKEN}/`

function setWith(redirectUrl: string, extensionId = ID): EngineRuleSet {
  return {
    id: engineSetId(extensionId, { kind: 'static', rulesetId: 'r' }),
    source: 'dnr',
    priority: 2000,
    enabled: true,
    rules: [
      {
        id: 1,
        action: { type: 'redirect', redirect: { url: redirectUrl } },
        condition: { urlFilter: '/ads.js', resourceTypes: ['script'] }
      },
      { id: 2, action: { type: 'block' }, condition: { urlFilter: '/track' } }
    ]
  }
}

describe('ExtensionResourceOrigin', () => {
  it('redirects to use_dynamic_url resources move to the served origin, others stay', () => {
    expect(origin.redirectTarget(ID, `chrome-extension://${ID}/war/noop.js`)).toBe(
      `${base}war/noop.js`
    )
    expect(origin.redirectTarget(ID, `chrome-extension://${ID}/war/noop.js?v=2`)).toBe(
      `${base}war/noop.js?v=2`
    )
    expect(origin.redirectTarget(ID, `chrome-extension://${ID}/plain/noop.js`)).toBeUndefined()
    expect(origin.redirectTarget(ID, `chrome-extension://${ID}/secret.json`)).toBeUndefined()
    expect(origin.redirectTarget(ID, `chrome-extension://${OTHER}/war/noop.js`)).toBeUndefined()
    expect(origin.redirectTarget(ID, 'https://cdn.example/noop.js')).toBeUndefined()
    expect(origin.redirectTarget(OTHER, `chrome-extension://${OTHER}/war/noop.js`)).toBeUndefined()
  })

  it('rewrites a translated set in place of nothing else, and returns the same object untouched', () => {
    const set = setWith(`chrome-extension://${ID}/war/noop.js`)
    const out = origin.rewriteSet(set)
    expect(out).not.toBe(set)
    expect(out.rules?.[0]?.action.redirect?.url).toBe(`${base}war/noop.js`)
    expect(out.rules?.[1]).toBe(set.rules?.[1])
    expect(set.rules?.[0]?.action.redirect?.url).toBe(`chrome-extension://${ID}/war/noop.js`)
    const plain = setWith(`chrome-extension://${ID}/plain/noop.js`)
    expect(origin.rewriteSet(plain)).toBe(plain)
    expect(origin.rewriteSet({ ...plain, id: 'filter-list' })).toEqual({
      ...plain,
      id: 'filter-list'
    })
  })

  it('the sink hands the engine the rewritten set', () => {
    const engine = new RuleEngine()
    createDnrSink(engine, origin).setRuleSet(setWith(`chrome-extension://${ID}/war/noop.js`))
    const decision = engine.decide({
      url: 'https://ads.example/ads.js',
      type: 'script',
      method: 'GET',
      initiator: 'https://news.example'
    })
    expect(decision).toMatchObject({ action: 'redirect', redirectUrl: `${base}war/noop.js` })
  })

  it('serves web-accessible files with their type and CORS, and nothing else', async () => {
    const ok = await origin.serve(`${base}war/noop.js`)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(ok.headers.get('access-control-allow-origin')).toBe('*')
    expect(await ok.text()).toBe('window.noop = 1\n')
    const gif = await origin.serve(`${base}war/blank.gif?cache=1`)
    expect(gif.status).toBe(200)
    expect(gif.headers.get('content-type')).toBe('image/gif')
    expect((await gif.arrayBuffer()).byteLength).toBe(3)
    // Listed without `use_dynamic_url`: web-accessible all the same, so served here too.
    expect((await origin.serve(`${base}plain/ok.js`)).status).toBe(200)
    expect((await origin.serve(`${base}plain/none.js`)).status).toBe(404)
    // Not web-accessible at all, however the path is spelled.
    expect((await origin.serve(`${base}secret.json`)).status).toBe(403)
    expect((await origin.serve(`${base}war/../secret.json`)).status).toBe(403)
    expect((await origin.serve(`${base}war/%2e%2e/secret.json`)).status).toBe(403)
    expect((await origin.serve(`${base}war/missing.js`)).status).toBe(404)
    expect((await origin.serve(base)).status).toBe(404)
  })

  it('refuses a wrong token, an unknown extension and a malformed URL', async () => {
    const wrongToken = `${EXTENSION_RESOURCE_SCHEME}://${ID}.${TOKEN.replace('0', '1')}/war/noop.js`
    expect((await origin.serve(wrongToken)).status).toBe(404)
    expect((await origin.serve(`${EXTENSION_RESOURCE_SCHEME}://${ID}/war/noop.js`)).status).toBe(
      404
    )
    expect(
      (await origin.serve(`${EXTENSION_RESOURCE_SCHEME}://${OTHER}.${TOKEN}/war/noop.js`)).status
    ).toBe(404)
    expect((await origin.serve('not a url')).status).toBe(400)
  })

  it('draws a fresh token per instance', () => {
    const a = new ExtensionResourceOrigin(() => served)
    const b = new ExtensionResourceOrigin(() => served)
    expect(a.urlFor(ID, 'war/noop.js')).not.toBe(b.urlFor(ID, 'war/noop.js'))
    expect(a.urlFor(ID, '/war/noop.js')).toMatch(
      new RegExp(`^${EXTENSION_RESOURCE_SCHEME}://${ID}\\.[0-9a-f]{32}/war/noop\\.js$`)
    )
  })
})
