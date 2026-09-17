import { describe, expect, it } from 'vitest'
import {
  ACTION_MENU_TOP_LEVEL_LIMIT,
  ERROR_CANNOT_FIND_ITEM,
  ERROR_CHECKED,
  ERROR_DESCENDANT_PARENT,
  ERROR_DUPLICATE_ID,
  ERROR_ID_REQUIRED,
  ERROR_INVALID_CONTEXT,
  ERROR_INVALID_URL_PATTERN,
  ERROR_ONCLICK_DISALLOWED,
  ERROR_OWN_PARENT,
  ERROR_PARENTS_MUST_BE_NORMAL,
  ERROR_TITLE_NEEDED,
  MenuRegistry,
  actionMenuEntriesFor,
  formatMenuError,
  menuEntriesFor,
  menuItemMatchesClick,
  normalizeCreateProperties,
  normalizeUpdateProperties,
  onClickData,
  substituteSelection,
  type MenuClickContext,
  type MenuCreateProperties,
  type MenuItem
} from '../api/contextMenus'

const EXT = 'abcdefghijklmnopabcdefghijklmnop'

const click = (overrides: Partial<MenuClickContext> = {}): MenuClickContext => ({
  pageUrl: 'https://example.com/page',
  frameUrl: '',
  frameId: 0,
  linkUrl: '',
  srcUrl: '',
  mediaType: 'none',
  selectionText: '',
  editable: false,
  ...overrides
})

const props = (overrides: Partial<MenuCreateProperties> = {}): MenuCreateProperties => ({
  type: 'normal',
  title: 'Item',
  ...overrides
})

describe('normalizeCreateProperties', () => {
  it('defaults the type to normal and keeps the fields Chrome defines', () => {
    expect(
      normalizeCreateProperties(
        {
          id: 'x',
          title: 'Do it',
          contexts: ['selection', 'link'],
          documentUrlPatterns: ['https://*.example.com/*'],
          targetUrlPatterns: ['*://*/*.png'],
          visible: false,
          enabled: false,
          parentId: 7
        },
        { requiresId: true }
      )
    ).toEqual({
      type: 'normal',
      id: 'x',
      title: 'Do it',
      contexts: ['selection', 'link'],
      documentUrlPatterns: ['https://*.example.com/*'],
      targetUrlPatterns: ['*://*/*.png'],
      visible: false,
      enabled: false,
      parentId: 7
    })
  })

  it('requires an id for workers and event pages, and refuses onclick there', () => {
    expect(() => normalizeCreateProperties({ title: 'x' }, { requiresId: true })).toThrow(
      ERROR_ID_REQUIRED
    )
    expect(normalizeCreateProperties({ title: 'x' }, { requiresId: false }).id).toBeUndefined()
    // The shim sends `true` in place of the function.
    expect(() =>
      normalizeCreateProperties({ id: 'x', title: 'x', onclick: true }, { requiresId: true })
    ).toThrow(ERROR_ONCLICK_DISALLOWED)
    expect(() =>
      normalizeCreateProperties({ title: 'x', onclick: true }, { requiresId: false })
    ).not.toThrow()
  })

  it('applies the title, checked, contexts and pattern rules', () => {
    expect(() => normalizeCreateProperties({ id: 'x' }, { requiresId: true })).toThrow(
      ERROR_TITLE_NEEDED
    )
    expect(() =>
      normalizeCreateProperties({ id: 'x', type: 'separator' }, { requiresId: true })
    ).not.toThrow()
    expect(() =>
      normalizeCreateProperties({ id: 'x', title: 'x', checked: true }, { requiresId: true })
    ).toThrow(ERROR_CHECKED)
    expect(
      normalizeCreateProperties(
        { id: 'x', title: 'x', type: 'checkbox', checked: true },
        { requiresId: true }
      ).checked
    ).toBe(true)
    expect(() =>
      normalizeCreateProperties({ id: 'x', title: 'x', contexts: [] }, { requiresId: true })
    ).toThrow(ERROR_INVALID_CONTEXT)
    expect(() =>
      normalizeCreateProperties(
        { id: 'x', title: 'x', contexts: ['toolbar'] },
        { requiresId: true }
      )
    ).toThrow(ERROR_INVALID_CONTEXT)
    expect(() =>
      normalizeCreateProperties(
        { id: 'x', title: 'x', documentUrlPatterns: ['nope'] },
        { requiresId: true }
      )
    ).toThrow(formatMenuError(ERROR_INVALID_URL_PATTERN, 'nope'))
    expect(() => normalizeCreateProperties({ id: '', title: 'x' }, { requiresId: true })).toThrow(
      /Invalid value for id/
    )
    expect(() =>
      normalizeCreateProperties({ id: 'x', type: 'menu' }, { requiresId: true })
    ).toThrow(/Invalid value for type/)
  })

  it('normalizeUpdateProperties keeps everything optional and lets parentId: null detach', () => {
    expect(normalizeUpdateProperties({})).toEqual({})
    expect(normalizeUpdateProperties({ parentId: null, enabled: true })).toEqual({
      parentId: null,
      enabled: true
    })
    expect(() => normalizeUpdateProperties({ title: 1 })).toThrow(/Invalid value for title/)
  })
})

describe('MenuRegistry', () => {
  it('generates numeric ids that skip the ones taken and refuses duplicates', () => {
    const registry = new MenuRegistry(EXT)
    expect(registry.create(props()).id).toBe(1)
    registry.create(props({ id: 2 }))
    expect(registry.create(props()).id).toBe(3)
    // A string '1' is a different item from the number 1.
    expect(registry.create(props({ id: '1' })).id).toBe('1')
    expect(() => registry.create(props({ id: 2 }))).toThrow(formatMenuError(ERROR_DUPLICATE_ID, 2))
    expect(registry.size).toBe(4)
    expect(registry.topLevelIds()).toEqual([1, 2, 3, '1'])
  })

  it('places children under normal parents only and removes subtrees', () => {
    const registry = new MenuRegistry(EXT)
    registry.create(props({ id: 'parent' }))
    registry.create(props({ id: 'child', parentId: 'parent' }))
    registry.create(props({ id: 'grandchild', parentId: 'child' }))
    registry.create(props({ id: 'sep', type: 'separator' }))
    expect(registry.get('parent')?.children).toEqual(['child'])
    expect(registry.topLevelIds()).toEqual(['parent', 'sep'])
    expect(() => registry.create(props({ id: 'under-sep', parentId: 'sep' }))).toThrow(
      ERROR_PARENTS_MUST_BE_NORMAL
    )
    expect(() => registry.create(props({ id: 'orphan', parentId: 'missing' }))).toThrow(
      formatMenuError(ERROR_CANNOT_FIND_ITEM, 'missing')
    )
    expect(registry.remove('child')).toEqual(['grandchild', 'child'])
    expect(registry.get('parent')?.children).toEqual([])
    expect(registry.size).toBe(2)
    registry.removeAll()
    expect(registry.size).toBe(0)
    expect(registry.topLevelIds()).toEqual([])
  })

  it('reparents without cycles and detaches with parentId null', () => {
    const registry = new MenuRegistry(EXT)
    registry.create(props({ id: 'a' }))
    registry.create(props({ id: 'b', parentId: 'a' }))
    registry.create(props({ id: 'c', parentId: 'b' }))
    expect(() => registry.update('a', { parentId: 'a' })).toThrow(ERROR_OWN_PARENT)
    expect(() => registry.update('a', { parentId: 'c' })).toThrow(ERROR_DESCENDANT_PARENT)
    registry.update('c', { parentId: 'a' })
    expect(registry.get('a')?.children).toEqual(['b', 'c'])
    expect(registry.get('b')?.children).toEqual([])
    registry.update('c', { parentId: null })
    expect(registry.get('c')?.parentId).toBeNull()
    expect(registry.topLevelIds()).toEqual(['a', 'c'])
    // Turning a parent into a checkbox is refused while it has children.
    expect(() => registry.update('a', { type: 'checkbox' })).toThrow(ERROR_PARENTS_MUST_BE_NORMAL)
    expect(() => registry.update('c', { checked: true })).toThrow(ERROR_CHECKED)
    expect(() => registry.update('c', { title: '' })).toThrow(ERROR_TITLE_NEEDED)
  })

  it('toggles checkboxes and keeps one radio item checked per consecutive group', () => {
    const registry = new MenuRegistry(EXT)
    registry.create(props({ id: 'box', type: 'checkbox' }))
    registry.create(props({ id: 'r1', type: 'radio', checked: true }))
    registry.create(props({ id: 'r2', type: 'radio' }))
    registry.create(props({ id: 'sep', type: 'separator' }))
    registry.create(props({ id: 'r3', type: 'radio', checked: true }))
    expect(registry.clicked('box')).toEqual({ wasChecked: false, checked: true })
    expect(registry.clicked('box')).toEqual({ wasChecked: true, checked: false })
    expect(registry.clicked('r2')).toEqual({ wasChecked: false, checked: true })
    expect(registry.get('r1')?.checked).toBe(false)
    // The separator ends the group: r3 keeps its own state.
    expect(registry.get('r3')?.checked).toBe(true)
    // Creating a checked radio unchecks its group siblings.
    registry.create(props({ id: 'r4', type: 'radio', checked: true }))
    expect(registry.get('r3')?.checked).toBe(false)
    expect(registry.clicked('missing')).toBeNull()
    // A normal item reports its (false) state unchanged.
    registry.create(props({ id: 'plain' }))
    expect(registry.clicked('plain')).toEqual({ wasChecked: false, checked: false })
  })
})

describe('menuItemMatchesClick', () => {
  const item = (
    contexts: string[],
    patterns: Partial<{ doc: string[]; target: string[] }> = {}
  ): MenuItem => {
    const registry = new MenuRegistry(EXT)
    return registry.create(
      props({
        id: 'i',
        contexts: contexts as MenuCreateProperties['contexts'],
        documentUrlPatterns: patterns.doc,
        targetUrlPatterns: patterns.target
      })
    )
  }

  it('shows page items only when nothing more specific applies', () => {
    expect(menuItemMatchesClick(item(['page']), click())).toBe(true)
    expect(menuItemMatchesClick(item(['page']), click({ linkUrl: 'https://a.com/' }))).toBe(false)
    expect(menuItemMatchesClick(item(['page']), click({ selectionText: 'hi' }))).toBe(false)
    expect(menuItemMatchesClick(item(['page']), click({ editable: true }))).toBe(false)
    expect(menuItemMatchesClick(item(['all']), click({ linkUrl: 'https://a.com/' }))).toBe(true)
  })

  it('matches links, media and frames against targetUrlPatterns and frame URLs', () => {
    const link = click({ linkUrl: 'https://cdn.example.com/x.png' })
    expect(menuItemMatchesClick(item(['link']), link)).toBe(true)
    expect(menuItemMatchesClick(item(['link'], { target: ['*://*.example.com/*'] }), link)).toBe(
      true
    )
    expect(menuItemMatchesClick(item(['link'], { target: ['*://other.org/*'] }), link)).toBe(false)
    const image = click({ mediaType: 'image', srcUrl: 'https://img.example.com/a.jpg' })
    expect(menuItemMatchesClick(item(['image']), image)).toBe(true)
    expect(menuItemMatchesClick(item(['video']), image)).toBe(false)
    expect(menuItemMatchesClick(item(['image'], { target: ['*://*/*.jpg'] }), image)).toBe(true)
    expect(menuItemMatchesClick(item(['image'], { target: ['*://*/*.png'] }), image)).toBe(false)
    const frame = click({ frameUrl: 'https://embed.example.com/f', frameId: 4 })
    expect(menuItemMatchesClick(item(['frame']), frame)).toBe(true)
    expect(menuItemMatchesClick(item(['frame']), click())).toBe(false)
    expect(menuItemMatchesClick(item(['selection']), click({ selectionText: 'x' }))).toBe(true)
    expect(menuItemMatchesClick(item(['editable']), click({ editable: true }))).toBe(true)
  })

  it('checks documentUrlPatterns against the clicked frame, else the page', () => {
    const scoped = item(['all'], { doc: ['https://*.example.com/*'] })
    expect(menuItemMatchesClick(scoped, click())).toBe(true)
    expect(menuItemMatchesClick(scoped, click({ pageUrl: 'https://other.org/' }))).toBe(false)
    expect(
      menuItemMatchesClick(scoped, click({ frameUrl: 'https://other.org/frame', frameId: 2 }))
    ).toBe(false)
    expect(
      menuItemMatchesClick(
        scoped,
        click({ pageUrl: 'https://other.org/', frameUrl: 'https://a.example.com/f', frameId: 2 })
      )
    ).toBe(true)
  })
})

describe('menuEntriesFor', () => {
  it('nests children under matching parents in creation order and substitutes %s', () => {
    const registry = new MenuRegistry(EXT)
    registry.create(props({ id: 'root', title: 'Search for "%s"', contexts: ['selection'] }))
    registry.create(props({ id: 'child', parentId: 'root', contexts: ['selection'] }))
    registry.create(props({ id: 'hidden', parentId: 'root', visible: false }))
    registry.create(props({ id: 'link-only', contexts: ['link'] }))
    registry.create(props({ id: 'another', contexts: ['selection'] }))
    const entries = menuEntriesFor(
      registry.all(),
      registry.topLevelIds(),
      click({ selectionText: '  hello\n  world ' })
    )
    expect(entries.map((e) => e.item.id)).toEqual(['root', 'another'])
    expect(entries[0].title).toBe('Search for "hello world"')
    expect(entries[0].children.map((e) => e.item.id)).toEqual(['child'])
  })

  it('shortens long selections with an ellipsis', () => {
    const long = 'x'.repeat(200)
    const out = substituteSelection('%s', long)
    expect(out.length).toBeLessThan(long.length)
    expect(out.endsWith('\u2026')).toBe(true)
    expect(substituteSelection('plain', 'sel')).toBe('plain')
  })
})

describe('actionMenuEntriesFor', () => {
  it('shows action-context items (browser_action under MV2) up to the top-level limit', () => {
    const registry = new MenuRegistry(EXT)
    for (let i = 0; i < ACTION_MENU_TOP_LEVEL_LIMIT + 2; i += 1) {
      registry.create(props({ id: `a${i}`, contexts: ['action'] }))
    }
    registry.create(props({ id: 'page', contexts: ['page'] }))
    registry.create(props({ id: 'legacy', contexts: ['browser_action'] }))
    registry.create(props({ id: 'everywhere', contexts: ['all'] }))
    registry.create(props({ id: 'sub', parentId: 'a0', contexts: ['page'] }))
    const mv3 = actionMenuEntriesFor(registry.all(), registry.topLevelIds(), 3)
    expect(mv3).toHaveLength(ACTION_MENU_TOP_LEVEL_LIMIT)
    expect(mv3.map((e) => e.item.id)).toEqual(['a0', 'a1', 'a2', 'a3', 'a4', 'a5'])
    // Children are not filtered by context.
    expect(mv3[0].children.map((e) => e.item.id)).toEqual(['sub'])
    const mv2 = actionMenuEntriesFor(registry.all(), registry.topLevelIds(), 2)
    expect(mv2.map((e) => e.item.id)).toEqual(['legacy', 'everywhere'])
  })
})

describe('onClickData', () => {
  it('leaves absent fields out and adds check state for checkbox and radio items', () => {
    const registry = new MenuRegistry(EXT)
    const parent = registry.create(props({ id: 'p' }))
    const box = registry.create(props({ id: 'b', type: 'checkbox', parentId: 'p' }))
    expect(onClickData(parent, click(), null)).toEqual({
      menuItemId: 'p',
      editable: false,
      pageUrl: 'https://example.com/page',
      frameId: 0
    })
    const info = onClickData(
      box,
      click({
        linkUrl: 'https://a.com/',
        srcUrl: 'https://a.com/i.png',
        mediaType: 'image',
        selectionText: 'sel',
        editable: true,
        frameUrl: 'https://f.com/',
        frameId: 3
      }),
      registry.clicked('b')
    )
    expect(info).toEqual({
      menuItemId: 'b',
      parentMenuItemId: 'p',
      mediaType: 'image',
      linkUrl: 'https://a.com/',
      srcUrl: 'https://a.com/i.png',
      pageUrl: 'https://example.com/page',
      frameUrl: 'https://f.com/',
      frameId: 3,
      selectionText: 'sel',
      editable: true,
      wasChecked: false,
      checked: true
    })
    // A normal item never carries check state, even when a state is passed.
    expect(onClickData(parent, click(), { wasChecked: false, checked: false })).not.toHaveProperty(
      'checked'
    )
  })
})
