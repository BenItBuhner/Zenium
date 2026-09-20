import { describe, expect, it } from 'vitest'
import type {
  ExtensionInfo,
  HostCapabilities,
  MenuItemDescriptor,
  Platform as PlatformOs
} from '../../shared/types'
import { Browser } from '../browser'
import type {
  ExtensionHost,
  MenuItemTemplate,
  Platform,
  StoreIO,
  TabView,
  TabViewHost,
  WindowHost
} from '../platform'
import type { ZenWindow } from '../window'

/*
 * The extension's own items of its action's context menu as data, for the phone's long-press
 * menu sheet (`extension.actionMenuItems`), and a pick among them (`extension.actionMenuClick`):
 * what `showExtensionActionMenu` puts above the browser's rows in the desktop's native menu, in
 * the same layout, with each item's click kept by a handle the sheet hands back.
 */

const ID = 'dbepggeogbaibhgnhhndojpepiihcmeb'
const OTHER = 'abcdefghijklmnopabcdefghijklmnop'
const EXT = { id: ID, name: 'Vimium', enabled: true, icon: null } as unknown as ExtensionInfo

function memoryIo(): StoreIO {
  const files: Record<string, string> = {}
  return {
    readSync: (name) => files[name] ?? null,
    write: async (name, text) => {
      files[name] = text
    },
    writeSync: (name, text) => {
      files[name] = text
    }
  }
}

function stub<T extends object>(overrides: Partial<T> = {}): T {
  return new Proxy(overrides as T, {
    get: (target, key) =>
      key in target ? Reflect.get(target, key) : key === 'then' ? undefined : () => undefined
  })
}

interface Harness {
  browser: Browser
  win: ZenWindow
  /** The labels of the items whose `click` ran, in order. */
  clicked: string[]
  /** How often the host was asked for the extension's items. */
  asked: () => number
  items: (id: string) => MenuItemDescriptor[]
  pick: (id: string, itemId: string) => void
}

/** The host's template for the extension: a plain item, a checked checkbox, a separator, a submenu. */
function ownItems(clicked: string[]): MenuItemTemplate[] {
  const item = (label: string, extra: Partial<MenuItemTemplate> = {}): MenuItemTemplate => ({
    label,
    click: () => {
      clicked.push(label)
    },
    ...extra
  })
  return [
    item('Open Dashboard'),
    item('Dark Mode', { type: 'checkbox', checked: true }),
    { type: 'separator' },
    {
      label: 'More',
      submenu: [item('Report an Issue'), item('Off for Now', { enabled: false })]
    }
  ]
}

function harness(extensions: ExtensionInfo[]): Harness {
  const clicked: string[] = []
  let asked = 0
  const platform: Platform = {
    info: { os: 'linux' as PlatformOs, version: '1.2.3' },
    capabilities: stub<HostCapabilities>({ windows: true, extensions: true }),
    io: memoryIo(),
    windows: {
      create: () =>
        stub<WindowHost>({
          alive: true,
          contentSize: () => ({ width: 1280, height: 800 }),
          normalBounds: () => null,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true
        })
    },
    views: stub<TabViewHost>({
      createView: () =>
        stub<TabView>({
          isDestroyed: () => false,
          isVisible: () => false,
          getURL: () => '',
          getTitle: () => '',
          hasDocument: () => false,
          canGoBack: () => false,
          canGoForward: () => false,
          getZoom: () => 1,
          isCurrentlyAudible: () => false
        })
    }),
    menus: { popup: () => undefined },
    dialogs: stub(),
    clipboard: stub(),
    shell: stub(),
    net: stub(),
    downloads: stub(),
    sessions: stub(),
    app: stub(),
    readabilitySource: () => null,
    createExtensions: () =>
      stub<ExtensionHost>({
        start: async () => undefined,
        list: () => extensions,
        actionContextMenuItems: (id) => {
          asked += 1
          return id === ID ? ownItems(clicked) : []
        }
      })
  }
  const browser = new Browser(platform)
  browser.start()
  const win = browser.allWindows()[0] as ZenWindow
  return {
    browser,
    win,
    clicked,
    asked: () => asked,
    items: (id) =>
      browser.handleCommand(win, 'extension.actionMenuItems', { id }) as MenuItemDescriptor[],
    pick: (id, itemId) => {
      browser.handleCommand(win, 'extension.actionMenuClick', { id, itemId })
    }
  }
}

describe('extension.actionMenuItems', () => {
  it('answers the extension’s action-context items in the native menu’s layout, as descriptors', () => {
    const h = harness([EXT])
    const items = h.items(ID)
    expect(items.map((i) => [i.type, i.label, i.enabled, i.checked])).toEqual([
      ['normal', 'Open Dashboard', true, false],
      ['checkbox', 'Dark Mode', true, true],
      ['separator', '', true, false],
      ['normal', 'More', true, false]
    ])
    expect(items[3].submenu?.map((i) => [i.label, i.enabled])).toEqual([
      ['Report an Issue', true],
      ['Off for Now', false]
    ])
    // Every item carries a handle of its own, submenu items included.
    const ids = [...items, ...(items[3].submenu ?? [])].map((i) => i.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(h.clicked).toEqual([])
  })

  it('is empty for an extension that adds none or that the browser does not know', () => {
    const h = harness([EXT, { ...EXT, id: OTHER, name: 'Plain' }])
    expect(h.items(OTHER)).toEqual([])
    expect(h.items('nosuchextensionnosuchextensionab')).toEqual([])
    // The host is not asked about an extension the browser does not list.
    expect(h.asked()).toBe(1)
  })
})

describe('extension.actionMenuClick', () => {
  it('runs the picked item’s click, a submenu’s too, and only once per menu', () => {
    const h = harness([EXT])
    const items = h.items(ID)
    h.pick(ID, items[0].id)
    expect(h.clicked).toEqual(['Open Dashboard'])
    // The menu has gone with the pick: its handles are retired.
    h.pick(ID, items[1].id)
    expect(h.clicked).toEqual(['Open Dashboard'])

    const again = h.items(ID)
    h.pick(ID, again[3].submenu![0].id)
    expect(h.clicked).toEqual(['Open Dashboard', 'Report an Issue'])
  })

  it('ignores a handle from a retired menu, another extension’s menu, or none', () => {
    const h = harness([EXT])
    const stale = h.items(ID)
    const fresh = h.items(ID)
    h.pick(ID, stale[0].id)
    expect(h.clicked).toEqual([])
    h.pick(OTHER, fresh[0].id)
    expect(h.clicked).toEqual([])
    h.pick(ID, 'action_99_1')
    expect(h.clicked).toEqual([])
    h.pick(ID, fresh[0].id)
    expect(h.clicked).toEqual(['Open Dashboard'])
  })
})
