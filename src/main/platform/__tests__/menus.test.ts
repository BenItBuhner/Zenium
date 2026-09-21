import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MenuItemTemplate } from '../../../core/platform'

/*
 * The host's native menu icons (`platform/menus.ts`): a `data:` or remote picture becomes the
 * item's 16 × 16 image. A favicon is square; the app menu's "Now playing…" row leads with a
 * media session's artwork, which is often wider than tall, and the hub's tile covers such a
 * picture (`object-fit: cover`) – so the host crops it to its centre square before the resize
 * rather than squashing it.
 */

interface FakeImage {
  size: { width: number; height: number }
  ops: string[]
  isEmpty: () => boolean
  getSize: () => { width: number; height: number }
  crop: (rect: { x: number; y: number; width: number; height: number }) => FakeImage
  resize: (size: { width: number; height: number }) => FakeImage
}

function image(width: number, height: number, ops: string[] = []): FakeImage {
  return {
    size: { width, height },
    ops,
    isEmpty: () => width === 0 || height === 0,
    getSize: () => ({ width, height }),
    crop: (rect) =>
      image(rect.width, rect.height, [
        ...ops,
        `crop ${rect.x},${rect.y} ${rect.width}×${rect.height}`
      ]),
    resize: (size) =>
      image(size.width, size.height, [...ops, `resize ${size.width}×${size.height}`])
  }
}

const built: Electron.MenuItemConstructorOptions[][] = []
/** The picture each `data:` URL decodes to, by URL. */
const decoded = new Map<string, FakeImage>()
/** The picture each remote URL fetches, by URL. */
const remote = new Map<string, FakeImage>()

vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: (items: Electron.MenuItemConstructorOptions[]) => {
      built.push(items)
      return { popup: vi.fn() }
    },
    setApplicationMenu: vi.fn()
  },
  nativeImage: {
    createFromDataURL: (src: string) => decoded.get(src) ?? image(0, 0),
    createFromBuffer: (buffer: Buffer) => remote.get(buffer.toString('utf8')) ?? image(0, 0)
  },
  net: {
    fetch: async (url: string) => ({
      ok: remote.has(url),
      arrayBuffer: async () => Buffer.from(url, 'utf8')
    })
  }
}))

const { ElectronMenus } = await import('../menus')

async function popup(items: MenuItemTemplate[]): Promise<Electron.MenuItemConstructorOptions[]> {
  const menus = new ElectronMenus()
  const win = { host: { alive: true, win: {} } } as never
  menus.popup(items, { source: 'app', win })
  // A menu with uncached remote icons opens once they are fetched.
  await new Promise((resolve) => setTimeout(resolve, 0))
  const last = built.at(-1)
  if (!last) throw new Error('no menu was built')
  return last
}

const icon = (item: Electron.MenuItemConstructorOptions): FakeImage =>
  item.icon as unknown as FakeImage

beforeEach(() => {
  built.length = 0
  decoded.clear()
  remote.clear()
})

describe('native menu icons', () => {
  it('resizes a square favicon to 16 without cropping', async () => {
    decoded.set('data:image/png;base64,SQUARE', image(32, 32))
    const [item] = await popup([{ label: 'Site', icon: 'data:image/png;base64,SQUARE' }])
    expect(icon(item).ops).toEqual(['resize 16×16'])
    expect(icon(item).size).toEqual({ width: 16, height: 16 })
  })

  it('crops a wide picture (a 16:9 artwork) to its centre square before the resize, as the hub’s tile covers it', async () => {
    decoded.set('data:image/jpeg;base64,WIDE', image(1200, 630))
    const [item] = await popup([{ label: 'Now playing…', icon: 'data:image/jpeg;base64,WIDE' }])
    expect(icon(item).ops).toEqual(['crop 285,0 630×630', 'resize 16×16'])
  })

  it('crops a tall picture the same way', async () => {
    decoded.set('data:image/png;base64,TALL', image(300, 500))
    const [item] = await popup([{ label: 'Now playing…', icon: 'data:image/png;base64,TALL' }])
    expect(icon(item).ops).toEqual(['crop 0,100 300×300', 'resize 16×16'])
  })

  it('treats a remote artwork the same, fetched before the menu opens', async () => {
    remote.set('https://music.example.com/cover.jpg', image(640, 360))
    const [item] = await popup([
      { label: 'Now playing…', icon: 'https://music.example.com/cover.jpg' }
    ])
    expect(icon(item).ops).toEqual(['crop 140,0 360×360', 'resize 16×16'])
  })

  it('leaves an item without a decodable picture icon-less', async () => {
    const [item] = await popup([{ label: 'Now playing…', icon: 'data:image/png;base64,BROKEN' }])
    expect(item.icon).toBeUndefined()
    const [plain] = await popup([{ label: 'Now playing…', icon: null }])
    expect(plain.icon).toBeUndefined()
  })
})
