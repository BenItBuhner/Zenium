// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { StrictMode, act, useEffect, type JSX, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SheetPresence, useSheetLeave } from '../motion/presence'

/*
 * The presence wrapper at a sheet boundary (lib/motion/presence.tsx, design language v2 draft
 * §11.1: the store's `null` means "leave", never "vanish"): the element a request last rendered
 * stays mounted after the request has gone, is told it is `leaving`, and is dropped when it
 * answers `onLeft`; a new request while one is leaving is a new generation above it, never a
 * reuse; a child that never reads the leave goes with its request, as before. The whole suite
 * runs under `<StrictMode>` (the #147 lesson): the generations are derived during render and the
 * consumer count is kept from layout effects, so the double render and the mount–cleanup–mount
 * of the effects leave both right.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let mount: HTMLElement | null = null

function render(el: ReactNode): void {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(<StrictMode>{el}</StrictMode>))
}

function rerender(el: ReactNode): void {
  act(() => root!.render(<StrictMode>{el}</StrictMode>))
}

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
  // After the unmount, which the sheets log.
  log = []
  answers.clear()
})

/** What the sheets report: mounts, unmounts and the leave they were told of. */
let log: string[] = []
/** Each sheet's answer to the wrapper, by name, for the test to call when the sheet "lands". */
const answers = new Map<string, () => void>()

/** A sheet on the chassis: reads the leave and answers it once told to land. */
function Sheet({ name, label = name }: { name: string; label?: string }): JSX.Element {
  const leave = useSheetLeave()
  useEffect(() => {
    log.push(`mount ${name}`)
    return () => {
      log.push(`unmount ${name}`)
    }
  }, [name])
  useEffect(() => {
    if (leave?.leaving) log.push(`leaving ${name}`)
  }, [leave?.leaving, name])
  if (leave) answers.set(name, leave.onLeft)
  return (
    <div data-sheet={name} data-leaving={leave?.leaving ? 'true' : undefined}>
      {label}
    </div>
  )
}

/** A mouse popover standing in for the sheet: never reads the leave. */
function Popover({ name }: { name: string }): JSX.Element {
  return <div data-popover={name} />
}

const sheets = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-sheet]')]
const names = (): string[] => sheets().map((el) => el.dataset.sheet!)
const leaving = (): string[] =>
  sheets()
    .filter((el) => el.dataset.leaving)
    .map((el) => el.dataset.sheet!)
const land = (name: string): void => {
  act(() => answers.get(name)!())
}

describe('SheetPresence (under StrictMode)', () => {
  it('renders nothing for no request, and the element for one', () => {
    render(<SheetPresence>{null}</SheetPresence>)
    expect(mount!.innerHTML).toBe('')
    rerender(
      <SheetPresence>
        <Sheet name="menu" />
      </SheetPresence>
    )
    expect(names()).toEqual(['menu'])
    expect(leaving()).toEqual([])
  })

  it('keeps the sheet mounted after its request has gone, tells it so, and drops it when it answers onLeft', () => {
    render(
      <SheetPresence>
        <Sheet name="menu" />
      </SheetPresence>
    )
    // StrictMode mounts, cleans up and mounts the effects again: one live sheet all the same.
    expect(log.filter((l) => l.startsWith('mount'))).toHaveLength(2)
    expect(log.filter((l) => l.startsWith('unmount'))).toHaveLength(1)
    log = []

    rerender(<SheetPresence>{null}</SheetPresence>)
    // The request is gone; the sheet is not: still in the tree, told it is leaving, not unmounted.
    expect(names()).toEqual(['menu'])
    expect(leaving()).toEqual(['menu'])
    expect(log).toEqual(['leaving menu'])

    // Renders of the wrapper with the request still gone change nothing.
    rerender(<SheetPresence>{null}</SheetPresence>)
    expect(names()).toEqual(['menu'])
    expect(log).toEqual(['leaving menu'])

    // The sheet lands: the subtree goes, once; a second answer is nothing.
    land('menu')
    expect(names()).toEqual([])
    expect(log).toEqual(['leaving menu', 'unmount menu'])
    expect(() => land('menu')).not.toThrow()
    expect(mount!.innerHTML).toBe('')
  })

  it('freezes the leaving sheet at the element it last committed', () => {
    render(
      <SheetPresence>
        <Sheet name="menu" label="Copy link" />
      </SheetPresence>
    )
    rerender(
      <SheetPresence>
        <Sheet name="menu" label="Copy link, Share" />
      </SheetPresence>
    )
    expect(sheets()[0].textContent).toBe('Copy link, Share')
    rerender(<SheetPresence>{null}</SheetPresence>)
    expect(sheets()[0].textContent).toBe('Copy link, Share')
    expect(leaving()).toEqual(['menu'])
  })

  it('a new request while one is leaving is a new generation above it – rendered after it, live – and the leaving one finishes behind it', () => {
    render(
      <SheetPresence>
        <Sheet key="1" name="first" />
      </SheetPresence>
    )
    rerender(<SheetPresence>{null}</SheetPresence>)
    expect(leaving()).toEqual(['first'])
    log = []
    rerender(
      <SheetPresence>
        <Sheet key="2" name="second" />
      </SheetPresence>
    )
    // Two sheets: the one on its way out first in the tree (under), the new one after it (over).
    expect(names()).toEqual(['first', 'second'])
    expect(leaving()).toEqual(['first'])
    expect(log.filter((l) => l.startsWith('mount'))).toEqual(['mount second', 'mount second'])
    // The old one lands: only it goes; the new one is untouched and still live.
    land('first')
    expect(names()).toEqual(['second'])
    expect(leaving()).toEqual([])
    expect(log).toContain('unmount first')
    expect(log.filter((l) => l === 'unmount second')).toHaveLength(1) // StrictMode's, at mount
  })

  it('a request replaced by another while the sheet stands (a menu popping over an open one, keyed by id) leaves the first and raises the second above it', () => {
    render(
      <SheetPresence>
        <Sheet key="a" name="a" />
      </SheetPresence>
    )
    rerender(
      <SheetPresence>
        <Sheet key="b" name="b" />
      </SheetPresence>
    )
    expect(names()).toEqual(['a', 'b'])
    expect(leaving()).toEqual(['a'])
    // And a third while both stand: three deep, the two below leaving in order.
    rerender(
      <SheetPresence>
        <Sheet key="c" name="c" />
      </SheetPresence>
    )
    expect(names()).toEqual(['a', 'b', 'c'])
    expect(leaving()).toEqual(['a', 'b'])
    land('b')
    expect(names()).toEqual(['a', 'c'])
    land('a')
    expect(names()).toEqual(['c'])
    expect(leaving()).toEqual([])
  })

  it('the same request asked for again while its sheet is leaving is a new generation, never a reuse', () => {
    // The same key (the request) twice: the instances are told apart by name here.
    render(
      <SheetPresence>
        <Sheet key="m" name="old" />
      </SheetPresence>
    )
    rerender(<SheetPresence>{null}</SheetPresence>)
    rerender(
      <SheetPresence>
        <Sheet key="m" name="new" />
      </SheetPresence>
    )
    expect(names()).toEqual(['old', 'new'])
    expect(leaving()).toEqual(['old'])
    // A generation's leave never goes back to false: the old one's answer drops the old one.
    land('old')
    expect(names()).toEqual(['new'])
    expect(leaving()).toEqual([])
  })

  it('a keyless child is one request for as long as it is rendered', () => {
    render(
      <SheetPresence>
        <Sheet name="menu" label="one" />
      </SheetPresence>
    )
    rerender(
      <SheetPresence>
        <Sheet name="menu" label="two" />
      </SheetPresence>
    )
    expect(names()).toEqual(['menu'])
    expect(sheets()[0].textContent).toBe('two')
    expect(log.filter((l) => l.startsWith('mount'))).toHaveLength(2) // StrictMode's pair, once
  })

  it('drops a child that never reads the leave the moment its request goes, as before', () => {
    render(
      <SheetPresence>
        <Popover name="menu" />
      </SheetPresence>
    )
    expect(document.querySelector('[data-popover]')).not.toBeNull()
    rerender(<SheetPresence>{null}</SheetPresence>)
    expect(document.querySelector('[data-popover]')).toBeNull()
    expect(mount!.innerHTML).toBe('')
    // A new request after that is one generation.
    rerender(
      <SheetPresence>
        <Popover name="next" />
      </SheetPresence>
    )
    expect(document.querySelectorAll('[data-popover]')).toHaveLength(1)
  })

  it('a sheet that has landed before its request went answers at once: nothing is left behind', () => {
    // The surface's own dismissal: the sheet lands, reports `onDismissed`, the surface clears the
    // request; the sheet is told it is leaving and answers in the same effect pass.
    function Landed({ name }: { name: string }): JSX.Element {
      const leave = useSheetLeave()
      useEffect(() => {
        if (leave?.leaving) leave.onLeft()
      }, [leave])
      return <div data-sheet={name} />
    }
    render(
      <SheetPresence>
        <Landed name="menu" />
      </SheetPresence>
    )
    rerender(<SheetPresence>{null}</SheetPresence>)
    expect(names()).toEqual([])
    expect(mount!.innerHTML).toBe('')
  })

  it('the reader deep in the subtree counts, through StrictMode’s mount, cleanup, mount of its effects', () => {
    // The sheet reads the leave from inside a surface that does not (a `MenuSheet` around its
    // `BottomSheet`). Were the attach counted at render (doubled by StrictMode) or its detach
    // lost in the cleanup, the wrapper would wait for nobody or drop the reader at once.
    function Surface(): JSX.Element {
      return (
        <div data-surface="menu">
          <Sheet name="menu" />
        </div>
      )
    }
    render(
      <SheetPresence>
        <Surface />
      </SheetPresence>
    )
    rerender(<SheetPresence>{null}</SheetPresence>)
    expect(names()).toEqual(['menu'])
    expect(leaving()).toEqual(['menu'])
    land('menu')
    expect(names()).toEqual([])
    expect(document.querySelector('[data-surface]')).toBeNull()
  })

  it('takes one element or nothing: text is not a request', () => {
    render(<SheetPresence>{'text'}</SheetPresence>)
    expect(mount!.innerHTML).toBe('')
    rerender(<SheetPresence>{false}</SheetPresence>)
    expect(mount!.innerHTML).toBe('')
  })
})
