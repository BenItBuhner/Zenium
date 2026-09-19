import { describe, expect, it } from 'vitest'
import {
  CONTENT_SCRIPT_PRELUDE_FILE,
  contentScriptPreludeFile,
  contentScriptWantsPrelude,
  transformManifestBytes,
  withContentScriptPrelude,
  withPreludeFirst
} from '../contentScriptPrelude'
import { contentScriptPreludeSource } from '../api/contentScriptStorage'
import { utf8Decode, utf8Encode } from '../bytes'

// `content_scripts` sections of store manifests measured by the desktop compatibility sweep (the
// rows the prelude fixes and the ones that must not regress), as the developers wrote them.
const VIMIUM = {
  manifest_version: 3,
  name: 'Vimium',
  version: '2.4.2',
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: [
        'lib/types.js',
        'lib/utils.js',
        'lib/keyboard_utils.js',
        'lib/dom_utils.js',
        'lib/settings.js',
        'content_scripts/mode.js',
        'content_scripts/vimium_frontend.js'
      ],
      css: ['content_scripts/vimium.css'],
      run_at: 'document_start',
      all_frames: true,
      match_about_blank: true
    },
    {
      matches: ['file:///', 'file:///*/'],
      css: ['content_scripts/file_urls.css'],
      run_at: 'document_start',
      all_frames: true
    }
  ]
}

const VIDEO_SPEED_CONTROLLER = {
  manifest_version: 3,
  name: 'Video Speed Controller',
  version: '0.11.1',
  content_scripts: [
    {
      matches: ['http://*/*', 'https://*/*', 'file:///*'],
      all_frames: true,
      match_about_blank: true,
      exclude_matches: ['https://hangouts.google.com/*', 'https://meet.google.com/*'],
      js: ['content-bridge.js'],
      run_at: 'document_start',
      world: 'ISOLATED'
    },
    {
      matches: ['http://*/*', 'https://*/*', 'file:///*'],
      all_frames: true,
      match_about_blank: true,
      exclude_matches: ['https://hangouts.google.com/*', 'https://meet.google.com/*'],
      css: ['styles/inject.css'],
      js: ['inject.js'],
      run_at: 'document_idle',
      world: 'MAIN'
    }
  ]
}

const LANGUAGETOOL = {
  manifest_version: 3,
  name: '__MSG_appName__',
  version: '11.2.3',
  content_scripts: [
    {
      all_frames: true,
      match_about_blank: true,
      match_origin_as_fallback: true,
      js: ['extension-loader.js'],
      matches: ['<all_urls>'],
      run_at: 'document_end'
    },
    {
      all_frames: true,
      match_about_blank: true,
      match_origin_as_fallback: true,
      css: ['common/fonts.css', 'content/styles/styles.css'],
      matches: ['<all_urls>'],
      run_at: 'document_end'
    },
    {
      world: 'MAIN',
      all_frames: true,
      js: ['content/editors/google/gdocs-content.js'],
      matches: ['*://docs.google.com/document/*'],
      run_at: 'document_start'
    },
    {
      all_frames: true,
      js: ['content/languagetool/injector.js'],
      matches: ['*://languagetool.org/*'],
      run_at: 'document_start'
    }
  ]
}

const DARK_READER = {
  manifest_version: 3,
  name: 'Dark Reader',
  version: '4.9.132',
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['inject/proxy.js'],
      run_at: 'document_start',
      all_frames: true,
      match_about_blank: true,
      world: 'MAIN'
    },
    {
      matches: ['<all_urls>'],
      js: ['inject/fallback.js', 'inject/index.js'],
      run_at: 'document_start',
      all_frames: true,
      match_about_blank: true,
      world: 'ISOLATED'
    },
    {
      matches: ['<all_urls>'],
      js: ['inject/color-scheme-watcher.js'],
      run_at: 'document_idle',
      all_frames: false,
      match_about_blank: false,
      world: 'ISOLATED'
    }
  ]
}

const UBLOCK_ORIGIN_MV2 = {
  manifest_version: 2,
  name: 'uBlock Origin',
  version: '1.75.0',
  content_scripts: [
    {
      all_frames: true,
      js: ['/js/vapi.js', '/js/vapi-client.js', '/js/contentscript.js'],
      match_about_blank: true,
      matches: ['http://*/*', 'https://*/*'],
      run_at: 'document_start'
    },
    {
      all_frames: false,
      js: ['/js/scriptlets/subscriber.js'],
      matches: ['https://easylist.to/*'],
      run_at: 'document_idle'
    }
  ]
}

const UBLOCK_ORIGIN_LITE = {
  manifest_version: 3,
  name: '__MSG_extName__',
  version: '2026.914.1325',
  background: { service_worker: '/js/background.js', type: 'module' },
  permissions: ['activeTab', 'declarativeNetRequest', 'scripting', 'storage']
}

function jsLists(manifest: Record<string, unknown>): unknown[][] {
  const scripts = manifest.content_scripts as Array<Record<string, unknown>>
  return scripts.map((entry) => (Array.isArray(entry.js) ? entry.js : []))
}

describe('contentScriptWantsPrelude', () => {
  it('wants it for isolated-world entries with scripts', () => {
    expect(contentScriptWantsPrelude({ js: ['a.js'] })).toBe(true)
    expect(contentScriptWantsPrelude({ js: ['a.js'], world: 'ISOLATED' })).toBe(true)
  })

  it('leaves main-world and CSS-only entries alone', () => {
    expect(contentScriptWantsPrelude({ js: ['a.js'], world: 'MAIN' })).toBe(false)
    expect(contentScriptWantsPrelude({ css: ['a.css'] })).toBe(false)
    expect(contentScriptWantsPrelude({ js: [] })).toBe(false)
    expect(contentScriptWantsPrelude({ js: 'a.js' })).toBe(false)
  })
})

describe('withPreludeFirst', () => {
  it('prepends once and is idempotent', () => {
    const once = withPreludeFirst(['a.js', 'b.js'])
    expect(once).toEqual([CONTENT_SCRIPT_PRELUDE_FILE, 'a.js', 'b.js'])
    expect(withPreludeFirst(once)).toBe(once)
  })

  it('takes a different file name for the scripting emulation', () => {
    expect(withPreludeFirst(['a.js'], '/other.js')).toEqual(['/other.js', 'a.js'])
  })
})

describe('withContentScriptPrelude', () => {
  it('puts the prelude first in every isolated-world list of Vimium and leaves CSS-only entries', () => {
    const rewrite = withContentScriptPrelude(VIMIUM)
    expect(rewrite.changed).toBe(true)
    expect(rewrite.entries).toBe(1)
    const [main, fileUrls] = jsLists(rewrite.manifest)
    expect(main[0]).toBe(CONTENT_SCRIPT_PRELUDE_FILE)
    expect(main.slice(1)).toEqual(VIMIUM.content_scripts[0].js)
    expect(fileUrls).toEqual([])
    // The developer's other fields survive untouched.
    const scripts = rewrite.manifest.content_scripts as Array<Record<string, unknown>>
    expect(scripts[0].css).toEqual(['content_scripts/vimium.css'])
    expect(scripts[0].run_at).toBe('document_start')
    expect(scripts[0].match_about_blank).toBe(true)
    expect(scripts[1]).toBe(VIMIUM.content_scripts[1])
    expect(rewrite.manifest.name).toBe('Vimium')
  })

  it('skips the MAIN-world bridge of Video Speed Controller', () => {
    const rewrite = withContentScriptPrelude(VIDEO_SPEED_CONTROLLER)
    expect(rewrite.entries).toBe(1)
    const [isolated, main] = jsLists(rewrite.manifest)
    expect(isolated).toEqual([CONTENT_SCRIPT_PRELUDE_FILE, 'content-bridge.js'])
    expect(main).toEqual(['inject.js'])
  })

  it('treats LanguageTool entry by entry', () => {
    const rewrite = withContentScriptPrelude(LANGUAGETOOL)
    expect(rewrite.entries).toBe(2)
    expect(jsLists(rewrite.manifest)).toEqual([
      [CONTENT_SCRIPT_PRELUDE_FILE, 'extension-loader.js'],
      [],
      ['content/editors/google/gdocs-content.js'],
      [CONTENT_SCRIPT_PRELUDE_FILE, 'content/languagetool/injector.js']
    ])
  })

  it('keeps Dark Reader main-world proxy first in its own list and prepends to the isolated ones', () => {
    const rewrite = withContentScriptPrelude(DARK_READER)
    expect(jsLists(rewrite.manifest)).toEqual([
      ['inject/proxy.js'],
      [CONTENT_SCRIPT_PRELUDE_FILE, 'inject/fallback.js', 'inject/index.js'],
      [CONTENT_SCRIPT_PRELUDE_FILE, 'inject/color-scheme-watcher.js']
    ])
  })

  it('handles MV2 lists with leading slashes (uBlock Origin)', () => {
    const rewrite = withContentScriptPrelude(UBLOCK_ORIGIN_MV2)
    expect(jsLists(rewrite.manifest)[0]).toEqual([
      CONTENT_SCRIPT_PRELUDE_FILE,
      '/js/vapi.js',
      '/js/vapi-client.js',
      '/js/contentscript.js'
    ])
    expect(rewrite.manifest.manifest_version).toBe(2)
  })

  it('returns the same manifest object when there is nothing to do (uBlock Origin Lite)', () => {
    const rewrite = withContentScriptPrelude(UBLOCK_ORIGIN_LITE)
    expect(rewrite.changed).toBe(false)
    expect(rewrite.entries).toBe(0)
    expect(rewrite.manifest).toBe(UBLOCK_ORIGIN_LITE)
  })

  it('is idempotent: a rewritten manifest rewrites to itself', () => {
    const first = withContentScriptPrelude(VIMIUM)
    const second = withContentScriptPrelude(first.manifest)
    expect(second.changed).toBe(false)
    expect(second.entries).toBe(1)
    expect(second.manifest).toBe(first.manifest)
  })

  it('does not mutate the input', () => {
    const input = JSON.parse(JSON.stringify(DARK_READER)) as Record<string, unknown>
    withContentScriptPrelude(input)
    expect(input).toEqual(DARK_READER)
  })

  it('tolerates malformed content_scripts values', () => {
    expect(withContentScriptPrelude({ content_scripts: 'nope' }).changed).toBe(false)
    expect(withContentScriptPrelude({ content_scripts: [null, 1, { js: 'x' }] }).changed).toBe(
      false
    )
  })
})

describe('transformManifestBytes', () => {
  it('parses a commented manifest, transforms it and re-serialises it', () => {
    const bytes = utf8Encode(
      '{\n  // developer comment\n  "manifest_version": 3,\n  "content_scripts": [{"js": ["a.js"], "matches": ["<all_urls>"]}]\n}'
    )
    const out = transformManifestBytes(bytes, (m) => withContentScriptPrelude(m).manifest)
    const parsed = JSON.parse(utf8Decode(out)) as Record<string, unknown>
    expect(jsLists(parsed)).toEqual([[CONTENT_SCRIPT_PRELUDE_FILE, 'a.js']])
    expect(parsed.manifest_version).toBe(3)
  })

  it('keeps the developer key a pipeline wrote before it', () => {
    const bytes = utf8Encode(JSON.stringify({ ...VIMIUM, key: 'AAAA' }))
    const out = transformManifestBytes(bytes, (m) => withContentScriptPrelude(m).manifest)
    expect((JSON.parse(utf8Decode(out)) as Record<string, unknown>).key).toBe('AAAA')
  })

  it('returns bytes that are not a JSON object untouched', () => {
    const broken = utf8Encode('{ not json')
    expect(transformManifestBytes(broken, (m) => m)).toBe(broken)
    const array = utf8Encode('[1, 2]')
    expect(transformManifestBytes(array, (m) => m)).toBe(array)
  })
})

describe('contentScriptPreludeFile', () => {
  it('is the stringified prelude, invoked once, under the reserved file name', () => {
    const file = contentScriptPreludeFile()
    expect(file.path).toBe(CONTENT_SCRIPT_PRELUDE_FILE)
    const text = utf8Decode(file.bytes)
    expect(text).toBe(contentScriptPreludeSource())
    expect(text.startsWith('// Zenium content-script storage prelude ')).toBe(true)
    expect(text.trimEnd().endsWith(')();')).toBe(true)
    // Self-contained: no bundler helper or import may leak into the file.
    expect(text).not.toMatch(/\b(require|import|exports|__esModule)\b/)
    expect(() => new Function(text)).not.toThrow()
  })

  it('has a header that changes with the body', () => {
    const [header] = contentScriptPreludeSource().split('\n')
    expect(header).toMatch(/^\/\/ Zenium content-script storage prelude [0-9a-f]{8}$/)
  })
})
