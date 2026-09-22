import { describe, expect, it } from 'vitest'
import { inheritsOrigin, type FrameContext } from '../../api/matchPattern'
import type { BootGroup, ExtensionBoot, IsolationMode } from '../boot'
import { decideFrameBoot } from '../frameBoot'

const ID = 'dhdgffkkebhmkfjojejmpbldmpobfkfo'

function group(index: number, extra: Partial<BootGroup> = {}): BootGroup {
  return {
    index,
    runAt: 'document_start',
    world: 'ISOLATED',
    matches: ['<all_urls>'],
    excludeMatches: [],
    includeGlobs: [],
    excludeGlobs: [],
    allFrames: true,
    matchAboutBlank: false,
    matchOriginAsFallback: false,
    js: [`g${index}.js`],
    css: [],
    ...extra
  }
}

function extension(isolation: IsolationMode, groups: BootGroup[]): ExtensionBoot {
  return {
    id: ID,
    name: 'Frame test',
    version: '1.0',
    manifestVersion: 3,
    permissions: [],
    optionalPermissions: [],
    hostPermissions: ['<all_urls>'],
    manifest: {},
    messages: null,
    groups,
    isolation
  }
}

const page: FrameContext = {
  url: 'http://10.0.2.2:8765/us-target.html',
  isTopFrame: true,
  precursorUrl: null
}
const child: FrameContext = {
  url: 'http://10.0.2.2:8765/child.html',
  isTopFrame: false,
  precursorUrl: null
}
/** Tampermonkey's natives-harvest frame: `<iframe sandbox src="javascript:void 0">`, an about:blank document. */
const sandbox: FrameContext = { url: 'about:blank', isTopFrame: false, precursorUrl: page.url }
const srcdoc: FrameContext = { url: 'about:srcdoc', isTopFrame: false, precursorUrl: page.url }
const data: FrameContext = { url: 'data:text/html,<p>x', isTopFrame: false, precursorUrl: page.url }
const blob: FrameContext = {
  url: 'blob:http://10.0.2.2:8765/6f1c2a4e-0000-4000-8000-000000000000',
  isTopFrame: false,
  precursorUrl: page.url
}

describe('inheritsOrigin', () => {
  it('names the sub-frames whose document lives on an inherited origin', () => {
    expect(inheritsOrigin(sandbox)).toBe(true)
    expect(inheritsOrigin({ ...sandbox, url: 'about:blank?x' })).toBe(true)
    expect(inheritsOrigin(srcdoc)).toBe(true)
    expect(inheritsOrigin(data)).toBe(true)
    expect(inheritsOrigin(blob)).toBe(true)
    expect(inheritsOrigin({ ...blob, url: 'filesystem:http://a/temporary/x' })).toBe(true)
  })

  it('leaves top frames and sub-frames with a URL of their own alone', () => {
    expect(inheritsOrigin(page)).toBe(false)
    expect(inheritsOrigin({ url: 'about:blank', isTopFrame: true, precursorUrl: null })).toBe(false)
    expect(inheritsOrigin(child)).toBe(false)
  })
})

describe('decideFrameBoot', () => {
  it('runs every matching group in a frame with a URL of its own and touches it', () => {
    const ext = extension('with', [group(0), group(1, { allFrames: false })])
    expect(decideFrameBoot(ext, page, false)).toEqual({
      groups: ext.groups,
      touch: true,
      pristine: false
    })
    const inChild = decideFrameBoot(ext, child, false)
    expect(inChild.groups.map((g) => g.index)).toEqual([0])
    expect(inChild).toMatchObject({ touch: true, pristine: false })
  })

  it('leaves nothing in a sandbox frame under the with fallback when no declaration opts in', () => {
    // Tampermonkey's userScripts.register entries: allFrames, no matchAboutBlank, no fallback.
    const ext = extension('with', [group(0), group(1)])
    for (const frame of [sandbox, srcdoc, data, blob])
      expect(decideFrameBoot(ext, frame, false)).toEqual({
        groups: [],
        touch: false,
        pristine: true
      })
  })

  it('injects into a sandbox frame for a declaration that opts in, keeping the prototypes pristine', () => {
    // Stylus, LanguageTool, Dark Reader: all_frames with match_about_blank.
    const ext = extension('with', [group(0, { matchAboutBlank: true }), group(1)])
    const decision = decideFrameBoot(ext, sandbox, false)
    expect(decision.groups.map((g) => g.index)).toEqual([0])
    expect(decision).toMatchObject({ touch: true, pristine: true })
    // match_about_blank alone does not reach data: and blob: frames; match_origin_as_fallback does.
    expect(decideFrameBoot(ext, data, false)).toMatchObject({ groups: [], touch: false })
    const fallback = extension('with', [group(0, { matchOriginAsFallback: true })])
    expect(decideFrameBoot(fallback, data, false).groups.map((g) => g.index)).toEqual([0])
    expect(decideFrameBoot(fallback, blob, false)).toMatchObject({ touch: true, pristine: true })
    expect(decideFrameBoot(fallback, sandbox, false).groups.map((g) => g.index)).toEqual([0])
  })

  it('matches the opt-in on the precursor URL, as Chrome does', () => {
    const ext = extension('with', [
      group(0, { matches: ['https://example.com/*'], matchAboutBlank: true })
    ])
    expect(decideFrameBoot(ext, sandbox, false)).toEqual({
      groups: [],
      touch: false,
      pristine: true
    })
    const under = { ...sandbox, precursorUrl: 'https://example.com/app' }
    expect(decideFrameBoot(ext, under, false).groups.map((g) => g.index)).toEqual([0])
    // An about:blank frame whose precursor is unknown matches nothing.
    expect(decideFrameBoot(ext, { ...sandbox, precursorUrl: null }, false).touch).toBe(false)
  })

  it('always touches a frame in an isolated world, invisible to the page', () => {
    const ext = extension('world', [group(0)])
    expect(decideFrameBoot(ext, sandbox, false)).toEqual({
      groups: [],
      touch: true,
      pristine: false
    })
    const optedIn = extension('world', [group(0, { matchAboutBlank: true })])
    expect(decideFrameBoot(optedIn, sandbox, false)).toMatchObject({
      touch: true,
      pristine: false
    })
    expect(decideFrameBoot(optedIn, sandbox, false).groups.map((g) => g.index)).toEqual([0])
  })

  it('always touches on a late boot, with no groups: the host asked for a scope', () => {
    const ext = extension('with', [group(0)])
    expect(decideFrameBoot(ext, sandbox, true)).toEqual({
      groups: [],
      touch: true,
      pristine: true
    })
    expect(decideFrameBoot(ext, page, true)).toEqual({ groups: [], touch: true, pristine: false })
  })

  it('keeps a MAIN-world declaration to the same frame rules', () => {
    const ext = extension('with', [group(0, { world: 'MAIN' })])
    expect(decideFrameBoot(ext, sandbox, false).touch).toBe(false)
    expect(decideFrameBoot(ext, page, false).groups.map((g) => g.index)).toEqual([0])
  })
})
