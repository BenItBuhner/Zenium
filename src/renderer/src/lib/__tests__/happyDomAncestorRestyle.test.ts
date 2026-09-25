// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'

/*
 * The test environment restyles a descendant when an ANCESTOR's attribute changes, as a browser
 * does – the behaviour `patches/happy-dom+20.14.5.patch` gives happy-dom. A rule such as
 * `html[data-theme='dark'] [data-mark]` is matched once per element and cached; the walk up the
 * ancestors for a descendant combinator registered that cached match on the first ancestor it
 * tried and on none after it, so a change on `html` never reached the cache and
 * `getComputedStyle` kept the stale match until the element's own attributes or the tree
 * changed (or happy-dom's private `[PropertySymbol.clearCache]()` ran – the nudge
 * groupColorTheme.test.tsx used to carry). No nudge here: this is what every renderer test that
 * flips `html[data-theme]` – the attribute `useTheme`'s `paint()` writes – relies on.
 */

const html = document.documentElement

function mount(css: string, body: string): void {
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
  document.body.innerHTML = body
}

const computed = (el: Element, property: string): string =>
  getComputedStyle(el).getPropertyValue(property).trim()

afterEach(() => {
  document.head.innerHTML = ''
  document.body.innerHTML = ''
  html.removeAttribute('data-theme')
  html.removeAttribute('data-scheme')
})

describe('happy-dom restyles descendants on an ancestor’s attribute change (patches/happy-dom)', () => {
  it('follows html[data-theme] on a custom property, on and off again', () => {
    mount(
      `[data-mark] { --pick: light; }
       html[data-theme='dark'] [data-mark] { --pick: dark; }`,
      '<span data-mark></span>'
    )
    const el = document.querySelector('[data-mark]')!
    expect(computed(el, '--pick')).toBe('light')

    html.setAttribute('data-theme', 'dark')
    expect(computed(el, '--pick')).toBe('dark')

    html.removeAttribute('data-theme')
    expect(computed(el, '--pick')).toBe('light')

    // A changed value, not just presence.
    html.setAttribute('data-theme', 'light')
    expect(computed(el, '--pick')).toBe('light')
    html.setAttribute('data-theme', 'dark')
    expect(computed(el, '--pick')).toBe('dark')
  })

  it('follows :root[data-theme] on a plain property, through intermediate elements', () => {
    mount(
      `.m { color: rgb(1, 1, 1); }
       :root[data-theme='dark'] .m { color: rgb(2, 2, 2); }`,
      '<div><section><span class="m"></span></section></div>'
    )
    const el = document.querySelector('.m')!
    expect(computed(el, 'color')).toBe('rgb(1, 1, 1)')
    html.setAttribute('data-theme', 'dark')
    expect(computed(el, 'color')).toBe('rgb(2, 2, 2)')
    html.removeAttribute('data-theme')
    expect(computed(el, 'color')).toBe('rgb(1, 1, 1)')
  })

  it('reaches an ancestor beyond the first one tried, whatever the combinators between', () => {
    // The change is on `main`, two ancestors above the span; `section` is tried first and
    // fails, then `main` – the ancestor the cache used to forget.
    mount(
      `main[data-scheme='dark'] div > span { --deep: yes; }`,
      '<main><section><div><span id="s"></span></div></section></main>'
    )
    const el = document.getElementById('s')!
    const main = document.querySelector('main')!
    expect(computed(el, '--deep')).toBe('')
    main.setAttribute('data-scheme', 'dark')
    expect(computed(el, '--deep')).toBe('yes')
    main.removeAttribute('data-scheme')
    expect(computed(el, '--deep')).toBe('')
  })

  it('drops the cached selector match itself, so matches() agrees with the style', () => {
    mount(`html[data-theme='dark'] [data-mark] { --pick: dark; }`, '<span data-mark></span>')
    const el = document.querySelector('[data-mark]')!
    const selector = "html[data-theme='dark'] [data-mark]"
    expect(el.matches(selector)).toBe(false)
    html.setAttribute('data-theme', 'dark')
    expect(el.matches(selector)).toBe(true)
    expect(computed(el, '--pick')).toBe('dark')
    html.removeAttribute('data-theme')
    expect(el.matches(selector)).toBe(false)
    expect(computed(el, '--pick')).toBe('')
  })

  it('keeps the direct parent’s attribute working as before', () => {
    mount(
      `[data-mark] { --pick: light; }
       div[data-theme='dark'] > [data-mark] { --pick: dark; }`,
      '<div><span data-mark></span></div>'
    )
    const el = document.querySelector('[data-mark]')!
    const parent = el.parentElement!
    expect(computed(el, '--pick')).toBe('light')
    parent.setAttribute('data-theme', 'dark')
    expect(computed(el, '--pick')).toBe('dark')
    parent.removeAttribute('data-theme')
    expect(computed(el, '--pick')).toBe('light')
  })
})
