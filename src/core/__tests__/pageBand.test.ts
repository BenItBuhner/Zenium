import { describe, expect, it } from 'vitest'
import type {
  HostCapabilities,
  LayoutReport,
  Platform as PlatformOs,
  Rect,
  Tab
} from '../../shared/types'
import { Browser } from '../browser'
import type { Platform, StoreIO, TabView, TabViewHost, WindowHost } from '../platform'
import type { ZenWindow } from '../window'
import { closeBootTabs } from './bootTab'

/*
 * The page-edge band's host seam on the desktop (motion spec §3.4, §6): the chrome lays the
 * page out under the band's SEAT once per travel and names the seat and the page's present
 * OFFSET in its layout report (`LayoutBand`); between reports each frame of the travel is one
 * `layout.pageOffset`, which moves the placed views' bounds by `offset - seat` against the
 * last report – a move of their bounds alone, never a resize, show, hide or radius – so a frame
 * costs one bounds write per view.
 */

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

/** What the fixture records about one tab view: every bounds write, and what else it was asked. */
interface RecordedView {
  readonly tabId: string
  bounds: Rect[]
  radii: number[]
  visibility: boolean[]
  visible: boolean
}

interface Fixture {
  browser: Browser
  win: ZenWindow
  views: RecordedView[]
  /** Open a page in a new tab; its view is owned by the window and shown at `AREA`. */
  openPage: (url: string) => RecordedView
}

const AREA: Rect = { x: 260, y: 48, width: 1000, height: 740 }

/** The page laid out under a seat: the frame's rect less the seat at its top. */
const under = (seat: number, rect: Rect = AREA): Rect => ({
  ...rect,
  y: rect.y + seat,
  height: rect.height - seat
})

const report = (
  tabIds: string[],
  band?: LayoutReport['band'],
  rect: Rect = AREA,
  contentHidden = false
): LayoutReport => ({
  placements: tabIds.map((tabId) => ({ tabId, rect, radius: 12 })),
  glance: null,
  contentHidden,
  ...(band ? { band } : {})
})

function fixture(): Fixture {
  const views: RecordedView[] = []
  const capabilities = stub<HostCapabilities>({
    windows: true,
    updates: false,
    agents: false,
    pageTabs: true
  })
  const platform: Platform = {
    info: { os: 'linux' as PlatformOs, version: '0.0.0' },
    capabilities,
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
      createView: (tab: Tab) => {
        const recorded: RecordedView = {
          tabId: tab.id,
          bounds: [],
          radii: [],
          visibility: [],
          visible: false
        }
        views.push(recorded)
        let url = ''
        return stub<TabView>({
          isDestroyed: () => false,
          isVisible: () => recorded.visible,
          setVisible: (visible: boolean) => {
            recorded.visibility.push(visible)
            recorded.visible = visible
          },
          setBounds: (rect: Rect) => {
            recorded.bounds.push({ ...rect })
          },
          setBorderRadius: (radius: number) => {
            recorded.radii.push(radius)
          },
          hasDocument: () => url !== '',
          getURL: () => url,
          getTitle: () => '',
          canGoBack: () => false,
          canGoForward: () => false,
          getZoom: () => 1,
          loadURL: (u: string) => {
            url = u
          }
        })
      }
    }),
    menus: stub(),
    dialogs: stub(),
    clipboard: stub(),
    shell: stub(),
    net: stub(),
    downloads: stub(),
    sessions: stub(),
    app: stub(),
    readabilitySource: () => null
  }
  const browser = new Browser(platform)
  browser.state.settings.onboardingDone = true
  browser.start()
  const win = browser.focusedWindow()
  const boot = win.selectedTabIn(win.activeSpace())
  if (boot) win.applyLayout(report([boot]))
  closeBootTabs(browser, views)
  const openPage = (url: string): RecordedView => {
    browser.handleCommand(win, 'urlbar.submit', {
      input: url,
      newTab: true,
      tabId: null,
      background: false
    })
    const tabId = win.selectedTabIn(win.activeSpace())
    const view = views.find((v) => v.tabId === tabId)
    if (!tabId || !view) throw new Error('the page did not open in a tab of its own')
    win.applyLayout(report([tabId]))
    return view
  }
  return { browser, win, views, openPage }
}

/** Forget what the view has been asked so far. */
function clear(view: RecordedView): void {
  view.bounds = []
  view.radii = []
  view.visibility = []
}

describe('the page-edge band’s seam (ZenWindow.applyLayout with a band, ZenWindow.setPageOffset)', () => {
  it('a report with no band places the views where it lays them out, and a frame then moves them by the offset alone', () => {
    const f = fixture()
    const page = f.openPage('https://example.com')
    expect(page.bounds.at(-1)).toEqual(AREA)
    expect(page.visible).toBe(true)
    clear(page)
    // The first frames of an open, before the chrome's layout under the seat has landed: the
    // page moves down against the rects it was laid out with (seat 0).
    f.win.setPageOffset(4.2)
    f.win.setPageOffset(9.7)
    expect(page.bounds).toEqual([
      { ...AREA, y: AREA.y + 4 },
      { ...AREA, y: AREA.y + 10 }
    ])
    // A frame of the travel is a bounds write and nothing else.
    expect(page.radii).toEqual([])
    expect(page.visibility).toEqual([])
    expect(page.visible).toBe(true)
  })

  it('an open: the page travels down at its full height (its bottom past the frame’s edge), and the rest lays it out once under the seat', () => {
    const f = fixture()
    const page = f.openPage('https://example.com')
    clear(page)
    // The band's departure seats nothing for an open (the lesser of 0 and the height): the
    // frames move the page as it was laid out, 740 tall, so its bottom rides past the frame's
    // edge rather than leaving a bare strip under it (§3.4).
    f.win.setPageOffset(20)
    f.win.setPageOffset(45)
    f.win.setPageOffset(56)
    expect(page.bounds).toEqual([
      { ...AREA, y: AREA.y + 20 },
      { ...AREA, y: AREA.y + 45 },
      { ...AREA, y: AREA.y + 56 }
    ])
    expect(page.radii).toEqual([])
    expect(page.visibility).toEqual([])
    // The rest: the chrome lays the page out under the seat – 56 down, 56 shorter, named
    // `seat: 56` with the page there (`offset: 56`) – the one resize of the travel (§3.1).
    clear(page)
    f.win.applyLayout(report([page.tabId], { seat: 56, offset: 56 }, under(56)))
    expect(page.bounds).toEqual([under(56)])
    expect(page.radii).toEqual([12])
    expect(page.visibility).toEqual([])
    // A report during a travel carries the offset of its moment: the page is placed where it
    // is, against the seat its rects were laid out with.
    clear(page)
    f.win.applyLayout(report([page.tabId], { seat: 56, offset: 30 }, under(56)))
    expect(page.bounds).toEqual([{ ...under(56), y: AREA.y + 30 }])
  })

  it('a leave: the layout home lands with the page still down, the frames carry it up against seat 0, and a frame that moves nothing writes nothing', () => {
    const f = fixture()
    const page = f.openPage('https://example.com')
    f.win.applyLayout(report([page.tabId], { seat: 56, offset: 56 }, under(56)))
    clear(page)
    // The band's departure for a leave: the page is laid out at the frame's top, full height,
    // but it is still 56 down – placed there.
    f.win.applyLayout(report([page.tabId], { seat: 0, offset: 56 }))
    expect(page.bounds).toEqual([{ ...AREA, y: AREA.y + 56 }])
    clear(page)
    f.win.setPageOffset(56)
    expect(page.bounds).toEqual([])
    f.win.setPageOffset(30)
    f.win.setPageOffset(0)
    f.win.setPageOffset(0)
    expect(page.bounds).toEqual([{ ...AREA, y: AREA.y + 30 }, AREA])
  })

  it('a re-target from 56 to 76 keeps the seat at 56 through the travel and seats 76 at the rest; back to 56, the seat is 56 from the departure', () => {
    const f = fixture()
    const page = f.openPage('https://example.com')
    f.win.applyLayout(report([page.tabId], { seat: 56, offset: 56 }, under(56)))
    clear(page)
    // Growing: no layout at the departure (the lesser of 56 and 76 is the seat already); the
    // page, laid out under 56, moves down past the frame's edge by up to 20 until the rest.
    f.win.setPageOffset(66)
    f.win.setPageOffset(76)
    expect(page.bounds).toEqual([
      { ...under(56), y: AREA.y + 66 },
      { ...under(56), y: AREA.y + 76 }
    ])
    clear(page)
    f.win.applyLayout(report([page.tabId], { seat: 76, offset: 76 }, under(76)))
    expect(page.bounds).toEqual([under(76)])
    // Shrinking: the departure seats 56 at once – the page, taller by 20 again, is placed where
    // it stands (76 down) and travels up to its laid-out rect.
    clear(page)
    f.win.applyLayout(report([page.tabId], { seat: 56, offset: 76 }, under(56)))
    expect(page.bounds).toEqual([{ ...under(56), y: AREA.y + 76 }])
    clear(page)
    f.win.setPageOffset(60)
    f.win.setPageOffset(56)
    expect(page.bounds).toEqual([{ ...under(56), y: AREA.y + 60 }, under(56)])
  })

  it('the frame moves every view the layout placed – a split’s panes – and none the chrome hid', () => {
    const f = fixture()
    const a = f.openPage('https://a.example')
    const b = f.openPage('https://b.example')
    const left: Rect = { x: 260, y: 48, width: 496, height: 740 }
    const right: Rect = { x: 764, y: 48, width: 496, height: 740 }
    f.win.applyLayout({
      placements: [
        { tabId: a.tabId, rect: under(56, left), radius: 12 },
        { tabId: b.tabId, rect: under(56, right), radius: 12 }
      ],
      glance: null,
      contentHidden: false,
      band: { seat: 56, offset: 0 }
    })
    clear(a)
    clear(b)
    f.win.setPageOffset(28)
    expect(a.bounds).toEqual([{ ...under(56, left), y: left.y + 28 }])
    expect(b.bounds).toEqual([{ ...under(56, right), y: right.y + 28 }])
    // The chrome over the page: the views are hidden, and a frame moves nothing.
    f.win.applyLayout(report([a.tabId, b.tabId], undefined, AREA, true))
    expect(a.visible).toBe(false)
    clear(a)
    clear(b)
    f.win.setPageOffset(40)
    expect(a.bounds).toEqual([])
    expect(b.bounds).toEqual([])
  })

  it('a frame for a window with no layout of its own yet moves nothing, and nothing of another window’s', () => {
    const f = fixture()
    const page = f.openPage('https://example.com')
    clear(page)
    const other = f.browser.createWindow({ kind: 'unsynced', from: f.win })!
    expect(() => other.setPageOffset(10)).not.toThrow()
    expect(page.bounds).toEqual([])
  })
})
