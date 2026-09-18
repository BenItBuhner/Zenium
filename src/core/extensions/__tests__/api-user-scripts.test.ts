import { describe, expect, it } from 'vitest'
import {
  DEFAULT_USER_SCRIPT_CSP,
  applyUpdates,
  emptyUserScriptsState,
  normalizeInjection,
  normalizeRegistrations,
  normalizeWorldConfig,
  parseUserScriptsState,
  planUserScripts,
  resetWorldConfig,
  selectScripts,
  serializeUserScriptsState,
  setWorldConfig,
  worldConfigFor,
  type RegisteredUserScript,
  type UserScriptsState
} from '../api/userScripts'

const NONE: ReadonlySet<string> = new Set()

function registered(overrides: Partial<RegisteredUserScript> = {}): RegisteredUserScript {
  return {
    id: 'a',
    matches: ['*://*/*'],
    allFrames: false,
    runAt: 'document_idle',
    world: 'USER_SCRIPT',
    js: [{ code: '1' }],
    ...overrides
  }
}

describe('userScripts.register validation', () => {
  it('fills Chrome defaults in', () => {
    const [script] = normalizeRegistrations(
      [{ id: 'a', matches: ['https://example.com/*'], js: [{ code: 'x' }] }],
      NONE
    )
    expect(script).toEqual({
      id: 'a',
      matches: ['https://example.com/*'],
      allFrames: false,
      runAt: 'document_idle',
      world: 'USER_SCRIPT',
      js: [{ code: 'x' }]
    })
  })

  it('keeps every optional field and strips leading slashes from file sources', () => {
    const [script] = normalizeRegistrations(
      [
        {
          id: 'a',
          matches: ['<all_urls>'],
          excludeMatches: ['https://bad.example/*'],
          includeGlobs: ['*example*'],
          excludeGlobs: ['*nope*'],
          allFrames: true,
          runAt: 'document_start',
          world: 'USER_SCRIPT',
          worldId: 'w1',
          js: [{ file: '/lib/a.js' }, { code: 'b' }]
        }
      ],
      NONE
    )
    expect(script.excludeMatches).toEqual(['https://bad.example/*'])
    expect(script.includeGlobs).toEqual(['*example*'])
    expect(script.excludeGlobs).toEqual(['*nope*'])
    expect(script.allFrames).toBe(true)
    expect(script.runAt).toBe('document_start')
    expect(script.worldId).toBe('w1')
    expect(script.js).toEqual([{ file: 'lib/a.js' }, { code: 'b' }])
  })

  it('rejects what Chrome rejects', () => {
    const bad = (scripts: unknown, message: RegExp): void =>
      expect(() => normalizeRegistrations(scripts, NONE)).toThrow(message)
    bad({}, /expected array/)
    bad([1], /expected object/)
    bad([{ matches: ['<all_urls>'], js: [{ code: '' }] }], /ID must not be empty/)
    bad([{ id: '_x', matches: ['<all_urls>'], js: [{ code: '' }] }], /must not start with '_'/)
    bad([{ id: 'a', js: [{ code: '' }] }], /must specify 'matches'/)
    bad([{ id: 'a', matches: [], js: [{ code: '' }] }], /must specify 'matches'/)
    bad([{ id: 'a', matches: ['nope'], js: [{ code: '' }] }], /invalid match pattern: 'nope'/)
    bad([{ id: 'a', matches: ['<all_urls>'] }], /at least one js source/)
    bad([{ id: 'a', matches: ['<all_urls>'], js: [] }], /at least one js source/)
    bad([{ id: 'a', matches: ['<all_urls>'], js: [{}] }], /exactly one of 'code' or 'file'/)
    bad(
      [{ id: 'a', matches: ['<all_urls>'], js: [{ code: 'a', file: 'b' }] }],
      /exactly one of 'code' or 'file'/
    )
    bad([{ id: 'a', matches: ['<all_urls>'], js: [{ code: '' }], runAt: 'now' }], /invalid 'runAt'/)
    bad([{ id: 'a', matches: ['<all_urls>'], js: [{ code: '' }], world: 'PAGE' }], /invalid 'world'/)
    bad(
      [{ id: 'a', matches: ['<all_urls>'], js: [{ code: '' }], world: 'MAIN', worldId: 'w' }],
      /specifies a world ID, but is not in the USER_SCRIPT world/
    )
    bad([{ id: 'a', matches: ['<all_urls>'], js: [{ code: '' }], worldId: '' }], /must be non-empty/)
    bad([{ id: 'a', matches: ['<all_urls>'], js: [{ code: '' }], worldId: '_r' }], /reserved/)
    bad(
      [{ id: 'a', matches: ['<all_urls>'], js: [{ code: '' }], excludeMatches: ['x'] }],
      /invalid exclude match pattern/
    )
  })

  it('refuses duplicate ids within the call and against the registered ones', () => {
    const one = { id: 'a', matches: ['<all_urls>'], js: [{ code: '' }] }
    expect(() => normalizeRegistrations([one, one], NONE)).toThrow(/Duplicate script ID 'a'/)
    expect(() => normalizeRegistrations([one], new Set(['a']))).toThrow(/Duplicate script ID 'a'/)
  })
})

describe('userScripts.update', () => {
  it('replaces the given properties and keeps the others', () => {
    const existing = [registered({ id: 'a', runAt: 'document_start' }), registered({ id: 'b' })]
    const next = applyUpdates(existing, [{ id: 'a', js: [{ code: '2' }], allFrames: true }])
    expect(next[0]).toEqual(
      registered({ id: 'a', runAt: 'document_start', js: [{ code: '2' }], allFrames: true })
    )
    expect(next[1]).toEqual(existing[1])
    expect(existing[0].js).toEqual([{ code: '1' }])
  })

  it('rejects unknown ids, repeats and emptied required fields', () => {
    const existing = [registered({ id: 'a' })]
    expect(() => applyUpdates(existing, [{ id: 'zz' }])).toThrow(/Nonexistent script ID 'zz'/)
    expect(() => applyUpdates(existing, [{ id: 'a' }, { id: 'a' }])).toThrow(/Duplicate/)
    expect(() => applyUpdates(existing, [{ id: 'a', matches: [] }])).toThrow(/must specify 'matches'/)
    expect(() => applyUpdates(existing, [{ id: 'a', js: [] }])).toThrow(/at least one js source/)
    expect(() => applyUpdates(existing, [{ id: 'a', world: 'MAIN', worldId: 'w' }])).toThrow(
      /not in the USER_SCRIPT world/
    )
  })

  it('a world ID left over from a USER_SCRIPT registration blocks a move to MAIN', () => {
    const existing = [registered({ id: 'a', worldId: 'w' })]
    expect(() => applyUpdates(existing, [{ id: 'a', world: 'MAIN' }])).toThrow(
      /not in the USER_SCRIPT world/
    )
  })
})

describe('getScripts / unregister filters', () => {
  const scripts = [registered({ id: 'a' }), registered({ id: 'b' })]

  it('selects everything without a filter or ids', () => {
    expect(selectScripts(scripts, undefined)).toEqual(scripts)
    expect(selectScripts(scripts, null)).toEqual(scripts)
    expect(selectScripts(scripts, {})).toEqual(scripts)
  })

  it('selects by id and validates the filter', () => {
    expect(selectScripts(scripts, { ids: ['b', 'zz'] })).toEqual([scripts[1]])
    expect(selectScripts(scripts, { ids: [] })).toEqual([])
    expect(() => selectScripts(scripts, 'a')).toThrow(/expected object/)
    expect(() => selectScripts(scripts, { ids: [1] })).toThrow(/expected strings/)
  })
})

describe('world configurations', () => {
  it('normalises configureWorld properties', () => {
    expect(normalizeWorldConfig({})).toEqual({ messaging: false })
    expect(normalizeWorldConfig({ csp: "script-src 'self'", messaging: true, worldId: 'w' })).toEqual({
      csp: "script-src 'self'",
      messaging: true,
      worldId: 'w'
    })
    expect(() => normalizeWorldConfig(null)).toThrow(/expected object/)
    expect(() => normalizeWorldConfig({ messaging: 'yes' })).toThrow(/must be a boolean/)
    expect(() => normalizeWorldConfig({ csp: 1 })).toThrow(/must be a string/)
    expect(() => normalizeWorldConfig({ worldId: '' })).toThrow(/must be non-empty/)
    expect(() => normalizeWorldConfig({ worldId: '_x' })).toThrow(/reserved/)
  })

  it('replaces the configuration of the same world and resets one', () => {
    let worlds = setWorldConfig([], { messaging: true })
    worlds = setWorldConfig(worlds, { worldId: 'w', csp: 'x', messaging: false })
    worlds = setWorldConfig(worlds, { messaging: false, csp: 'y' })
    expect(worlds).toEqual([
      { worldId: 'w', csp: 'x', messaging: false },
      { messaging: false, csp: 'y' }
    ])
    expect(worldConfigFor(worlds, 'w')).toEqual({ worldId: 'w', csp: 'x', messaging: false })
    expect(worldConfigFor(worlds, 'other')).toEqual({ messaging: false })
    expect(resetWorldConfig(worlds, undefined)).toEqual([{ worldId: 'w', csp: 'x', messaging: false }])
    expect(resetWorldConfig(worlds, 'w')).toEqual([{ messaging: false, csp: 'y' }])
    expect(() => resetWorldConfig(worlds, 3)).toThrow(/expected string/)
    expect(() => resetWorldConfig(worlds, '_w')).toThrow(/reserved/)
  })
})

describe('planUserScripts', () => {
  const state: UserScriptsState = {
    scripts: [
      registered({ id: 'init', runAt: 'document_start', matches: ['<all_urls>'], allFrames: true }),
      registered({ id: 'main', world: 'MAIN', matches: ['https://example.com/*'] }),
      registered({ id: 'w1', worldId: 'w1', matches: ['https://example.com/*'] }),
      registered({ id: 'other', matches: ['https://other.example/*'] })
    ],
    worlds: [{ worldId: 'w1', csp: "script-src 'none'", messaging: true }]
  }
  const top = { url: 'https://example.com/page', isTopFrame: true }
  const allow = { hostAccess: () => true, allowFileAccess: false }

  it('groups matching scripts by world, in registration order, with the world configuration', () => {
    const plan = planUserScripts(state, true, top, allow)
    expect(plan).toEqual([
      {
        world: 'USER_SCRIPT',
        worldId: null,
        csp: DEFAULT_USER_SCRIPT_CSP,
        messaging: false,
        scripts: [{ id: 'init', runAt: 'document_start', js: [{ code: '1' }] }]
      },
      { world: 'MAIN', worldId: null, csp: null, messaging: false, scripts: [{ id: 'main', runAt: 'document_idle', js: [{ code: '1' }] }] },
      {
        world: 'USER_SCRIPT',
        worldId: 'w1',
        csp: "script-src 'none'",
        messaging: true,
        scripts: [{ id: 'w1', runAt: 'document_idle', js: [{ code: '1' }] }]
      }
    ])
  })

  it('injects nothing while the toggle is off, without host access, or on other schemes', () => {
    expect(planUserScripts(state, false, top, allow)).toEqual([])
    expect(planUserScripts(state, true, top, { ...allow, hostAccess: () => false })).toEqual([])
    expect(planUserScripts(state, true, { url: 'chrome-extension://abc/x.html', isTopFrame: true }, allow)).toEqual([])
    expect(planUserScripts(state, true, { url: 'about:blank', isTopFrame: true }, allow)).toEqual([])
    expect(planUserScripts(emptyUserScriptsState(), true, top, allow)).toEqual([])
  })

  it('needs the file-access toggle for file: pages', () => {
    const frame = { url: 'file:///home/me/page.html', isTopFrame: true }
    expect(planUserScripts(state, true, frame, allow)).toEqual([])
    const plan = planUserScripts(state, true, frame, { ...allow, allowFileAccess: true })
    expect(plan.map((w) => w.scripts.map((s) => s.id))).toEqual([['init']])
  })

  it('sub-frames only get allFrames scripts', () => {
    const plan = planUserScripts(state, true, { ...top, isTopFrame: false }, allow)
    expect(plan.map((w) => w.scripts.map((s) => s.id))).toEqual([['init']])
  })
})

describe('userScripts.execute validation', () => {
  it('normalises an injection', () => {
    expect(normalizeInjection({ js: [{ code: '1' }], target: { tabId: 3 } })).toEqual({
      js: [{ code: '1' }],
      world: 'USER_SCRIPT',
      injectImmediately: false,
      target: { tabId: 3, allFrames: false }
    })
    expect(
      normalizeInjection({
        js: [{ file: '/a.js' }],
        world: 'MAIN',
        injectImmediately: true,
        target: { tabId: 3, frameIds: [0, 7] }
      })
    ).toEqual({
      js: [{ file: 'a.js' }],
      world: 'MAIN',
      injectImmediately: true,
      target: { tabId: 3, allFrames: false, frameIds: [0, 7] }
    })
  })

  it('rejects malformed injections', () => {
    const bad = (raw: unknown, message: RegExp): void =>
      expect(() => normalizeInjection(raw)).toThrow(message)
    bad(null, /expected object/)
    bad({ js: [{ code: '' }] }, /'target.tabId' must be an integer/)
    bad({ js: [], target: { tabId: 1 } }, /at least one js source/)
    bad({ js: [{ code: '' }], target: { tabId: 1 }, world: 'X' }, /Invalid 'world'/)
    bad({ js: [{ code: '' }], target: { tabId: 1 }, world: 'MAIN', worldId: 'w' }, /only be specified for the USER_SCRIPT world/)
    bad({ js: [{ code: '' }], target: { tabId: 1, frameIds: ['a'] } }, /must be integers/)
    bad({ js: [{ code: '' }], target: { tabId: 1, frameIds: [1], allFrames: true } }, /Cannot specify 'allFrames' if 'frameIds'/)
    bad({ js: [{ code: '' }], target: { tabId: 1, frameIds: [1], documentIds: ['d'] } }, /both 'frameIds' and 'documentIds'/)
    bad({ js: [{ code: '' }], target: { tabId: 1, documentIds: ['d'], allFrames: true } }, /Cannot specify 'allFrames' if 'documentIds'/)
  })
})

describe('persistence', () => {
  it('round-trips the state and drops what does not parse', () => {
    const state: UserScriptsState = {
      scripts: [registered({ id: 'a', worldId: 'w' })],
      worlds: [{ worldId: 'w', messaging: true }]
    }
    expect(parseUserScriptsState(serializeUserScriptsState(state))).toEqual(state)
    expect(parseUserScriptsState('not json')).toEqual(emptyUserScriptsState())
    expect(parseUserScriptsState('{"version":2}')).toEqual(emptyUserScriptsState())
    expect(
      parseUserScriptsState(JSON.stringify({ version: 1, scripts: [{ id: 'bad' }], worlds: [3, { messaging: true }] }))
    ).toEqual({ scripts: [], worlds: [{ messaging: true }] })
  })
})
