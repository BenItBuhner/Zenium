// @vitest-environment happy-dom
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { BookmarkNode, Folder, Space, Tab, UIState } from '@shared/types'
import { DEFAULT_CONTAINER_ID } from '@shared/types'
import { BOOKMARKS_BAR_ID } from '@shared/bookmarks'

/*
 * One tooltip vocabulary (design-language-v2-draft §9.31, a11y-26; W5-1's sweep): every chrome
 * control's name is the chrome's tooltip – `data-tooltip`, read by the one host
 * (components/Tooltip.tsx) – never the toolkit's `title`, so two controls a pointer's width
 * apart do not show two kinds. Pinned two ways: the desktop chrome rendered for real in
 * happy-dom – the sidebar in both forms with every row control, the toolbar, the bookmarks bar
 * – carries no native `title`, and every `data-tooltip` on it resolves for the host (the
 * control the event lands in, a text to show, a name for the tree where the control is one);
 * and the desktop chrome's sources hold no DOM element with a `title` beyond the ones listed
 * here with their reasons, and none with both words on one element.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

const { browserStore, uiStore } = await import('@renderer/lib/ui')
const { TOOLTIP_ATTR, tooltipTargetOf, tooltipText } = await import('@renderer/lib/tooltip')
const { defaultShortcuts } = await import('@shared/shortcuts')
const { Sidebar } = await import('../sidebar/Sidebar')
const { Toolbar } = await import('../Toolbar')
const { BookmarksBar } = await import('../bookmarks/BookmarksBar')

function tab(id: string, over: Partial<Tab> = {}): Tab {
  return {
    id,
    spaceId: 'space',
    containerId: DEFAULT_CONTAINER_ID,
    url: `https://${id}.example/`,
    title: id.toUpperCase(),
    favicon: null,
    pinned: false,
    essential: false,
    pinnedUrl: null,
    customTitle: null,
    customIcon: null,
    windowId: null,
    folderId: null,
    loading: false,
    progress: 0,
    canGoBack: false,
    canGoForward: false,
    audible: false,
    muted: false,
    discarded: false,
    frozen: false,
    cpuThrottle: 1,
    zoom: 1,
    splitGroupId: null,
    createdAt: 0,
    lastActiveAt: 0,
    errorCode: null,
    bookmarked: false,
    readerable: false,
    blockedCount: 0,
    ...over
  } as Tab
}

const folder: Folder = {
  id: 'work',
  spaceId: 'space',
  name: 'Work',
  icon: '📁',
  color: null,
  collapsed: false
} as Folder

const BOOKMARKS: BookmarkNode[] = [
  {
    id: BOOKMARKS_BAR_ID,
    parentId: '0',
    index: 0,
    type: 'folder',
    title: 'Bookmarks bar',
    dateAdded: 0
  },
  {
    id: 'b1',
    parentId: BOOKMARKS_BAR_ID,
    index: 0,
    type: 'url',
    title: 'Docs',
    url: 'https://docs.example/',
    dateAdded: 0
  },
  { id: 'b2', parentId: BOOKMARKS_BAR_ID, index: 1, type: 'folder', title: 'Reading', dateAdded: 0 }
]

/** Every row control at once: ×, reset, mute, wake, the governor's, an alert, a live folder. */
const TABS: Tab[] = [
  tab('e1', { essential: true }),
  tab('p1', { pinned: true, pinnedUrl: 'https://home.example/', url: 'https://away.example/' }),
  tab('f1', { folderId: 'work' }),
  tab('l1'),
  tab('l2', { audible: true }),
  tab('l3', { muted: true }),
  tab('l4', { discarded: true, sleepSavedMb: 12 } as Partial<Tab>),
  tab('l5', { frozen: true }),
  tab('l6', { cpuThrottle: 4 }),
  tab('l7', { alert: 'bluetooth' } as Partial<Tab>)
]

function fixture(expanded: boolean): { state: UIState; space: Space } {
  const space: Space = {
    id: 'space',
    name: 'Home',
    icon: '',
    containerId: DEFAULT_CONTAINER_ID,
    theme: null,
    tabIds: TABS.filter((t) => !t.essential).map((t) => t.id),
    activeTabId: 'l1',
    pinnedCollapsed: false
  }
  const state = {
    platform: 'linux',
    capabilities: { windowControls: false },
    window: { kind: 'synced', fullscreen: false, htmlFullscreenTabId: null },
    tabs: Object.fromEntries(TABS.map((t) => [t.id, t])),
    spaces: [space],
    activeSpaceId: 'space',
    folders: { work: folder },
    liveFolders: { work: { error: null } },
    splitGroups: {},
    essentialTabIds: ['e1'],
    foreignTabIds: [],
    agents: [],
    containers: [],
    media: [],
    boosts: [],
    extensions: [],
    bookmarks: BOOKMARKS,
    downloads: [],
    downloadsProgress: { received: 0, total: 0, indeterminate: false, active: 0 },
    shortcuts: defaultShortcuts('linux', 'chrome'),
    blockedPopups: {},
    permissionRules: [],
    translate: { available: true, tabs: {} },
    securityPrompts: [],
    autofill: { prompts: [], picker: null },
    settings: {
      showTabSeparator: true,
      sidebarExpanded: expanded,
      sidebarSide: 'left',
      toolbarLayout: 'single',
      urlbarBehavior: 'normal',
      showBookmarksBar: 'always'
    }
  } as unknown as UIState
  return { state, space }
}

let root: Root | null = null
let mount: HTMLElement | null = null

function render(el: ReactElement): HTMLElement {
  if (!root) {
    mount = document.createElement('div')
    document.body.appendChild(mount)
    root = createRoot(mount)
  }
  act(() => root!.render(el))
  return mount!
}

afterEach(() => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  uiStore.set({ toasts: [], stripFocus: null })
})

const all = (selector: string, from: ParentNode = document): HTMLElement[] => [
  ...from.querySelectorAll<HTMLElement>(selector)
]

/** Whether the element is a control to the tree: a widget by tag or role, or a Tab stop. */
function isControl(el: HTMLElement): boolean {
  if (el.matches('button, a[href], input, select, textarea, summary')) return true
  const role = el.getAttribute('role')
  if (role && !['img', 'presentation', 'none', 'group', 'status', 'heading'].includes(role))
    return true
  return el.hasAttribute('tabindex')
}

/** The element's accessible name, near enough: its label, or the text it shows. */
function nameOf(el: HTMLElement): string {
  return (el.getAttribute('aria-label') ?? el.textContent ?? '').trim()
}

function expectOneVocabulary(chrome: HTMLElement, where: string): HTMLElement[] {
  expect(
    all('[title]', chrome).map((el) => el.outerHTML),
    `${where}: native titles`
  ).toEqual([])
  const carriers = all(`[${TOOLTIP_ATTR}]`, chrome)
  expect(carriers.length, `${where}: controls carrying a tooltip`).toBeGreaterThan(0)
  for (const el of carriers) {
    const text = tooltipText(el)
    // The host finds the carrier from any node inside it, and has words to show.
    expect(text.trim().length, `${where}: empty tooltip on ${el.outerHTML}`).toBeGreaterThan(0)
    expect(tooltipTargetOf(el), `${where}: ${el.outerHTML}`).toBe(el)
    expect(tooltipTargetOf(el.firstChild ?? el)).toBe(el)
    // A control keeps its name where the tooltip is not the name: the glyph is hidden from the tree.
    if (isControl(el))
      expect(nameOf(el).length, `${where}: unnamed ${el.outerHTML}`).toBeGreaterThan(0)
  }
  return carriers
}

describe('the desktop chrome, rendered: one tooltip vocabulary (§9.31, a11y-26)', () => {
  it('the expanded sidebar with every row control, the toolbar and the bookmarks bar carry no native title, and every data-tooltip resolves', () => {
    const { state } = fixture(true)
    browserStore.set({ state })
    const el = render(
      <>
        <Toolbar state={state} tab={state.tabs.l1 ?? null} />
        <BookmarksBar state={state} tab={state.tabs.l1 ?? null} />
        <Sidebar state={state} isDark={false} />
      </>
    )
    const carriers = expectOneVocabulary(el, 'expanded')
    const texts = carriers.map((c) => tooltipText(c))
    // The swept controls are among them: the row's ×, reset, mute, the moon, the governor's
    // snowflake and turtle, the alert, the Essentials tile, the bookmark chip's address, the
    // folder's live dot.
    expect(texts).toContain('Close tab')
    expect(texts).toContain('Reset pinned tab to its original URL')
    expect(texts).toContain('Mute tab')
    expect(texts).toContain('Unmute tab')
    expect(texts).toContain('Frozen by the resource governor – click to wake')
    expect(texts).toContain('CPU throttled ×4 by the resource governor – click to lift')
    expect(texts).toContain('This tab is connected to a Bluetooth device')
    expect(texts).toContain('https://docs.example/')
    expect(texts).toContain('Live folder – updates automatically')
    // A tile's and a sleeping row's tooltip is the title over its state, one line each.
    expect(texts).toContain('E1')
    expect(texts).toContain('L4\nSleeping – click to wake\nMemory saved: 12 MB')
    // The sleeping moon is named for what it does, its tooltip saying more.
    const moon = all('[data-tab-id="l4"] .zen-tab-sleeping')[0]!
    expect(moon.getAttribute('aria-label')).toBe('Sleeping – click to wake')
    // A folder chip has no address to show and so no tooltip.
    expect(all('[data-bm-chip="folder"]')[0]!.hasAttribute(TOOLTIP_ATTR)).toBe(false)
  })

  it('the icon rail names its rows by tooltip where their text is folded away', () => {
    const { state } = fixture(false)
    browserStore.set({ state })
    const el = render(<Sidebar state={state} isDark={false} />)
    const texts = expectOneVocabulary(el, 'rail').map((c) => tooltipText(c))
    expect(texts).toContain('Work')
  })
})

describe('the desktop chrome’s sources: title stays off DOM elements (§9.31)', () => {
  // `__dirname`, not `import.meta.url`: under happy-dom the module URL is the document's.
  const root = resolve(__dirname, '..')

  /** Not the desktop chrome: another host's, page content, or another programme's surface. */
  const NOT_DESKTOP_CHROME = [
    'phone/',
    'tablet/',
    // Page content inside the chrome document (Settings is services'); the host reaches it all the same.
    'pages/',
    // OverlayShell's content-area panels, shared with the phone: themes, spaces, boosts, add-ons, passwords.
    'overlays/',
    'extensions/',
    'autofill/',
    // Site information and the confirm chassis: W5-2's and W5-3's.
    'siteControls/',
    'siteinfo/',
    'dialogs/'
  ]

  /**
   * The native titles left, by file, each with its reason – a follow-up in the wave report. A
   * new one anywhere else fails here.
   */
  const LEFT: Record<string, { count: number; why: string }> = {
    // The one control (Remove suggestion), an image's title and a badge's label: W5-3 (#425) has hunks in the file.
    'urlbar/Urlbar.tsx': {
      count: 3,
      why: 'W5-3 holds the file; the Remove suggestion button follows'
    },
    // The extension side panel's Close and the split cover: W5-5 (#426) has hunks in the file.
    'content/ContentArea.tsx': { count: 2, why: 'W5-5 holds the file' },
    // The phone's downloads panel (the desktop opens Downloads as a page tab).
    'downloads/DownloadsSheet.tsx': { count: 3, why: 'a phone surface' },
    // A dialog's address line, a truncated label: labels in W5-3's chassis and file.
    'protocol/ExternalProtocolSheet.tsx': { count: 1, why: 'a dialog line, not a control' },
    'security/BlockedPopupsPanel.tsx': { count: 1, why: 'a truncated label; W5-3 holds the file' }
  }

  function sources(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') out.push(...sources(path))
      } else if (entry.name.endsWith('.tsx')) out.push(path)
    }
    return out
  }

  interface Found {
    file: string
    line: number
    tag: string
    both: boolean
  }

  /** Every DOM element (a lowercase tag) written with a `title` attribute, and whether it also carries the tooltip. */
  function nativeTitles(file: string): Found[] {
    const text = readFileSync(file, 'utf8')
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const found: Found[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isJsxOpeningLikeElement(node) && ts.isIdentifier(node.tagName)) {
        const tag = node.tagName.text
        if (/^[a-z]/.test(tag)) {
          const names = node.attributes.properties
            .filter((p): p is ts.JsxAttribute => ts.isJsxAttribute(p))
            .map((p) => (ts.isIdentifier(p.name) ? p.name.text : p.name.getText(source)))
          if (names.includes('title')) {
            const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
            found.push({
              file: relative(root, file).split('\\').join('/'),
              line: line + 1,
              tag,
              both: names.includes(TOOLTIP_ATTR)
            })
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    return found
  }

  const files = sources(root)
    .map((f) => ({ path: f, rel: relative(root, f).split('\\').join('/') }))
    .filter(({ rel }) => !NOT_DESKTOP_CHROME.some((dir) => rel.startsWith(dir)))

  it('no DOM element in the desktop chrome carries both title and data-tooltip', () => {
    const both = files.flatMap(({ path }) => nativeTitles(path)).filter((f) => f.both)
    expect(both).toEqual([])
  })

  it('the native titles left are the listed ones, for the listed reasons', () => {
    const byFile = new Map<string, Found[]>()
    for (const { path } of files) {
      for (const found of nativeTitles(path)) {
        const list = byFile.get(found.file) ?? []
        list.push(found)
        byFile.set(found.file, list)
      }
    }
    const left = Object.fromEntries([...byFile].map(([file, list]) => [file, list.length]))
    expect(left).toEqual(
      Object.fromEntries(Object.entries(LEFT).map(([f, { count }]) => [f, count]))
    )
  })
})
