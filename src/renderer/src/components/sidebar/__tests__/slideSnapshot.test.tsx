// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, useLayoutEffect, useRef, type JSX, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SlideMotion } from '@renderer/lib/motion/slide'
import { SlideSnapshot } from '../SlideSnapshot'

/*
 * The settled read before a list's commit (MOT-33's delta): the panel reads the list where it
 * stands just before the commit that flips it mutates the DOM – in `getSnapshotBeforeUpdate`,
 * ahead of every mutation of the commit – and on those commits alone, so the FLIP after them
 * springs no row from a place it is not.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLElement | null = null

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
  vi.restoreAllMocks()
})

/** A list of rows with the panels' shape: the snapshot leaf, the rows, the flip after the commit. */
function Panel({
  motion,
  rows,
  tick = 0
}: {
  motion: SlideMotion
  rows: string[]
  tick?: number
}): JSX.Element {
  const orderKey = rows.join('|')
  const scroller = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    motion.flip(null, true)
  }, [motion, orderKey])
  return (
    <div>
      <SlideSnapshot motion={motion} deps={[orderKey]} />
      <div ref={scroller} data-tab-scroller data-tick={tick}>
        {rows.map((id) => (
          <div key={id} data-row={id} ref={(el) => motion.attach(id, el)}>
            {id}
          </div>
        ))}
      </div>
    </div>
  )
}

function render(element: ReactElement): void {
  if (!host) {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  }
  act(() => root?.render(element))
}

describe('SlideSnapshot', () => {
  it('reads the list before the commit that flips it mutates the DOM, and not at the mount', () => {
    const motion = new SlideMotion('y', { enter: true })
    const seen: string[][] = []
    const record = vi.spyOn(motion, 'record').mockImplementation(() => {
      seen.push(
        [...document.querySelectorAll<HTMLElement>('[data-row]')].map((r) => r.dataset.row!)
      )
    })
    const flip = vi.spyOn(motion, 'flip')
    render(<Panel motion={motion} rows={['a', 'b']} />)
    expect(record).not.toHaveBeenCalled()
    expect(flip).toHaveBeenCalledTimes(1)
    render(<Panel motion={motion} rows={['a', 'b', 'c']} />)
    // The read saw the list as it stood – two rows – before the commit put the third in; the
    // flip ran after, on the three.
    expect(record).toHaveBeenCalledTimes(1)
    expect(seen).toEqual([['a', 'b']])
    expect(flip).toHaveBeenCalledTimes(2)
    expect(record.mock.invocationCallOrder[0]).toBeLessThan(flip.mock.invocationCallOrder[1])
    render(<Panel motion={motion} rows={['a', 'c']} />)
    expect(seen).toEqual([
      ['a', 'b'],
      ['a', 'b', 'c']
    ])
  })

  it('reads nothing for a commit that does not flip (the same rows rendered again)', () => {
    const motion = new SlideMotion('y', { enter: true })
    const record = vi.spyOn(motion, 'record').mockImplementation(() => undefined)
    render(<Panel motion={motion} rows={['a', 'b']} />)
    render(<Panel motion={motion} rows={['a', 'b']} tick={1} />)
    expect(host?.querySelector('[data-tick="1"]')).not.toBeNull()
    expect(record).not.toHaveBeenCalled()
  })
})
