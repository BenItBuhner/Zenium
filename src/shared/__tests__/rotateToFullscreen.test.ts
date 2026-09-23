// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { rotateManaged } from '../rotateToFullscreen'

function define(target: object, name: string, value: unknown): void {
  Object.defineProperty(target, name, { value, configurable: true, writable: true })
}

describe('rotateManaged: the fullscreen element a turn of the screen leaves', () => {
  it("is a <video> itself, controls or not, but not a player's wrapper nor one hiding fullscreen", () => {
    const bare = document.createElement('video')
    expect(rotateManaged(bare)).toBe(true)
    const wrapper = document.createElement('div')
    wrapper.appendChild(document.createElement('video'))
    expect(rotateManaged(wrapper)).toBe(false)
    expect(rotateManaged(document.createElement('canvas'))).toBe(false)
    const noFullscreen = document.createElement('video')
    define(noFullscreen, 'controlsList', { contains: (token: string) => token === 'nofullscreen' })
    expect(rotateManaged(noFullscreen)).toBe(false)
  })
})
