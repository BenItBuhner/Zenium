import { createElement, Fragment, type JSX } from 'react'
import { describe, expect, it } from 'vitest'
import { hasElementOfType } from '../children'

function Toggle(): JSX.Element {
  return createElement('button')
}
function Field(): JSX.Element {
  return createElement('input')
}
/** A component that renders a Toggle: what it renders must not count, only what was handed in. */
function WrapsToggle(): JSX.Element {
  return createElement(Toggle)
}

describe('hasElementOfType', () => {
  it('finds a direct child of the given type', () => {
    expect(hasElementOfType(createElement(Toggle), [Toggle])).toBe(true)
    expect(hasElementOfType(createElement(Field), [Toggle])).toBe(false)
  })

  it('accepts any of several types', () => {
    expect(hasElementOfType(createElement(Field), [Toggle, Field])).toBe(true)
  })

  it('looks through arrays, conditionals and fragments', () => {
    const children = [
      false,
      null,
      'a label',
      createElement(Fragment, null, createElement('span'), createElement(Toggle))
    ]
    expect(hasElementOfType(children, [Toggle])).toBe(true)
    expect(hasElementOfType([false, null, 'text'], [Toggle])).toBe(false)
  })

  it('does not look into what other components render', () => {
    expect(hasElementOfType(createElement(WrapsToggle), [Toggle])).toBe(false)
  })

  it('treats host elements by tag name', () => {
    expect(hasElementOfType(createElement('input'), ['input'])).toBe(true)
    expect(hasElementOfType(createElement('button'), ['input'])).toBe(false)
  })
})
