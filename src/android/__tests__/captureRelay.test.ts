import { describe, expect, it } from 'vitest'
import type { Tab } from '@shared/types'
import type { TabCapture } from '@shared/captureState'
import { PRIVATE_CONTAINER_ID } from '@shared/types'
import { captureUpdates, type CapturesHeld } from '../captureRelay'

function tab(
  id: string,
  url: string,
  capture: Partial<TabCapture> | null,
  containerId = 'default'
): Tab {
  return {
    id,
    url,
    title: url,
    loading: false,
    containerId,
    capture: capture ? { camera: false, microphone: false, display: false, ...capture } : null
  } as unknown as Tab
}

const isPrivate = (t: Tab): boolean => t.containerId === PRIVATE_CONTAINER_ID

describe("captureUpdates (the host hears the tabs' capture, NOT-13)", () => {
  it('says nothing while no tab captures, and once per tab that starts', () => {
    const held: CapturesHeld = new Map()
    expect(captureUpdates(held, [tab('t1', 'https://meet.test/room', null)], isPrivate)).toEqual([])
    const first = captureUpdates(
      held,
      [tab('t1', 'https://meet.test/room', { microphone: true })],
      isPrivate
    )
    expect(first).toEqual([
      {
        tabId: 't1',
        url: 'https://meet.test/room',
        camera: false,
        microphone: true,
        private: false
      }
    ])
    // The same state again: the host heard it.
    expect(
      captureUpdates(held, [tab('t1', 'https://meet.test/room', { microphone: true })], isPrivate)
    ).toEqual([])
  })

  it('follows the kinds: the camera joining, then the microphone alone', () => {
    const held: CapturesHeld = new Map()
    captureUpdates(held, [tab('t1', 'https://meet.test/', { microphone: true })], isPrivate)
    expect(
      captureUpdates(
        held,
        [tab('t1', 'https://meet.test/', { microphone: true, camera: true })],
        isPrivate
      )
    ).toEqual([
      { tabId: 't1', url: 'https://meet.test/', camera: true, microphone: true, private: false }
    ])
    expect(
      captureUpdates(held, [tab('t1', 'https://meet.test/', { camera: true })], isPrivate)
    ).toEqual([
      { tabId: 't1', url: 'https://meet.test/', camera: true, microphone: false, private: false }
    ])
  })

  it('is silent on a same-site address change and speaks on a new site', () => {
    const held: CapturesHeld = new Map()
    captureUpdates(held, [tab('t1', 'https://meet.test/room/1', { microphone: true })], isPrivate)
    expect(
      captureUpdates(
        held,
        [tab('t1', 'https://meet.test/room/2#chat', { microphone: true })],
        isPrivate
      )
    ).toEqual([])
    expect(
      captureUpdates(held, [tab('t1', 'https://other.test/', { microphone: true })], isPrivate)
    ).toEqual([
      { tabId: 't1', url: 'https://other.test/', camera: false, microphone: true, private: false }
    ])
  })

  it("ends a tab's card with an all-clear when its capture ends or the tab is gone", () => {
    const held: CapturesHeld = new Map()
    captureUpdates(
      held,
      [
        tab('t1', 'https://meet.test/', { microphone: true }),
        tab('t2', 'https://cam.test/', { camera: true })
      ],
      isPrivate
    )
    expect(
      captureUpdates(
        held,
        [tab('t1', 'https://meet.test/', null), tab('t2', 'https://cam.test/', { camera: true })],
        isPrivate
      )
    ).toEqual([{ tabId: 't1', url: '', camera: false, microphone: false, private: false }])
    expect(captureUpdates(held, [], isPrivate)).toEqual([
      { tabId: 't2', url: '', camera: false, microphone: false, private: false }
    ])
    expect(held.size).toBe(0)
  })

  it("marks a private tab's capture private, and a display share alone is not the host's", () => {
    const held: CapturesHeld = new Map()
    expect(
      captureUpdates(
        held,
        [
          tab('p1', 'https://meet.test/', { microphone: true }, PRIVATE_CONTAINER_ID),
          tab('t2', 'https://share.test/', { display: true })
        ],
        isPrivate
      )
    ).toEqual([
      { tabId: 'p1', url: 'https://meet.test/', camera: false, microphone: true, private: true }
    ])
  })
})
