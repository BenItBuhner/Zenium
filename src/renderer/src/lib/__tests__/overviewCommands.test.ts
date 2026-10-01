import { describe, expect, it } from 'vitest'
import {
  dispatchOverviewCommand,
  onOverviewCommand,
  overviewCommandListeners
} from '../overviewCommands'

/*
 * The overview menu's chrome commands (tab overview cleanup spec §4): the core's
 * `overview.command` event reaches the mounted overview through one dispatcher; an unsubscribed
 * listener (the overview gone) hears nothing, and a command with no listener is dropped.
 */

describe('the overview command dispatcher', () => {
  it('hands each command to every listener until it unsubscribes; none, dropped', () => {
    const heard: string[] = []
    const off = onOverviewCommand((c) => heard.push(`a:${c}`))
    const offB = onOverviewCommand((c) => heard.push(`b:${c}`))
    expect(overviewCommandListeners()).toBe(2)
    dispatchOverviewCommand('select-tabs')
    expect(heard).toEqual(['a:select-tabs', 'b:select-tabs'])
    off()
    dispatchOverviewCommand('search-tabs')
    expect(heard).toEqual(['a:select-tabs', 'b:select-tabs', 'b:search-tabs'])
    offB()
    expect(overviewCommandListeners()).toBe(0)
    expect(() => dispatchOverviewCommand('close-all')).not.toThrow()
    expect(heard).toHaveLength(3)
  })

  it('a listener that unsubscribes mid-dispatch does not disturb the others', () => {
    const heard: string[] = []
    const off = onOverviewCommand((c) => {
      heard.push(`first:${c}`)
      off()
    })
    const offB = onOverviewCommand((c) => heard.push(`second:${c}`))
    dispatchOverviewCommand('switch-view')
    expect(heard).toEqual(['first:switch-view', 'second:switch-view'])
    offB()
  })
})
