/* eslint-disable react-refresh/only-export-components -- a library module: the wrapper ships with the hook the sheet inside it reads */
import type { JSX, ReactElement, ReactNode } from 'react'
import {
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'

/**
 * A sheet's leave outlives its request (design language v2 draft §11.1: the store's `null`
 * means "leave", never "vanish").
 *
 * A sheet is rendered by its request – `uiStore.menu`, a dialog's flag – and the store write that
 * clears the request would unmount the sheet in the same commit: gone on the next frame, its
 * scrim and the page's recede running back alone. Every host-driven close is such a write –
 * `menu.hide` from the core when a second menu pops while one is open, a back delivered as one
 * event (`handleSystemBack`), a local menu opening over an open menu – and so is the write a
 * surface makes once its own dismissal has landed.
 *
 * `SheetPresence` sits at the sheet boundary, around the element the request renders and only
 * around it, and keeps the chassis's side of the bargain: when the request goes (the child is
 * `null`, or its `key` names a new request) the wrapper keeps rendering the element it last
 * committed, tells it through {@link useSheetLeave} that it is `leaving`, and drops the subtree
 * when the sheet answers `onLeft`. A `BottomSheet` answers once its own dismissal has landed at
 * 0: p 1 → 0 over the travel it actually stands at, on the sheet spring, interruptible like any
 * dismissal (a finger catching it holds it, and the leave resumes with the finger's velocity
 * when it lets go), or the 120 ms fade in place under reduced motion (§11.3); its recede layer
 * leaves the stack and its cover of the page is let go only then. A sheet that had landed
 * already – the surface's own dismissal, whose `onDismissed` made the write – answers at once.
 * Nothing of the leave lives in the surface: `MenuSheet` renders as before; the store's `null` is
 * honoured as a leave by the chassis.
 *
 * A new request while one is leaving is a new generation above the old one – rendered after it,
 * so it paints over it and registers above it on the recede stack (§11.2) – never a reuse: the
 * leaving one finishes its way down behind the new one and is dropped when it lands. Requests
 * are told apart by the child's `key`, so a layer that can be asked for a new sheet while one is
 * up keys the child by the request (`MenuLayer` by `menu.id`); a keyless child is one request
 * for as long as it is rendered. A child that never reads {@link useSheetLeave} (a mouse popover
 * standing in for the sheet) is dropped the moment its request goes, as before.
 *
 * The frame dialog host retains its panels on the phone in the same spirit but on the DOM
 * (`FrameDialogHost` in lib/portals.tsx: a panel its owner unmounts while the host's sheet is on
 * its way down stays in the slot, inert, until the landing): there the sheet is the host's and
 * its panels are many and conditionally rendered deep in always-mounted surfaces; here the
 * sheet is the child. A desktop pose (the 24 px / 180 ms pop on a pointer host) is not this
 * wrapper's: it selects nothing by form factor and asks the sheet for the pose.
 *
 * StrictMode: the generations are state derived during render (pure, and idempotent under the
 * double render); the consumer count is kept from layout effects and undone in their cleanups,
 * so mount, cleanup, mount leaves it right.
 */

export interface SheetLeave {
  /**
   * The request that rendered this sheet is gone: run the dismissal from wherever the sheet
   * stands, and call `onLeft` once it has landed. Never goes back to false for a generation.
   */
  leaving: boolean
  /** The sheet is gone – landed, never up, or landed before the request went: drop the subtree. */
  onLeft: () => void
}

interface LeaveSlot extends SheetLeave {
  /** A sheet is reading the leave: the wrapper waits for its `onLeft`. Returns the detach. */
  attach: () => () => void
}

const SheetLeaveContext = createContext<LeaveSlot | null>(null)

/**
 * What the nearest `SheetPresence` says about this sheet: `leaving` once its request has gone,
 * and the `onLeft` to answer with once the sheet has landed. Null outside a wrapper (a sheet
 * whose request unmounts it directly): such a sheet reports through `onDismissed` alone.
 */
export function useSheetLeave(): SheetLeave | null {
  const slot = useContext(SheetLeaveContext)
  // Attached from a layout effect, before the wrapper's own layout effect asks whether anyone
  // is listening; StrictMode's mount, cleanup, mount leaves the count at one.
  useLayoutEffect(() => slot?.attach(), [slot])
  return slot
}

interface Generation {
  id: number
  key: ReactElement['key']
  /** What the generation renders: the live element while the request stands, the last committed one after. */
  element: ReactElement
  leaving: boolean
}

interface Generations {
  list: Generation[]
  next: number
}

/** The one element the request renders, or nothing. */
function requested(children: ReactNode): ReactElement | null {
  return isValidElement(children) ? children : null
}

function born(live: ReactElement, id: number): Generation {
  return { id, key: live.key, element: live, leaving: false }
}

/**
 * The presence wrapper at a sheet boundary: `children` is the element the request renders, or
 * nothing. See the module header for what it retains and how a sheet inside answers.
 */
export function SheetPresence({ children }: { children?: ReactNode }): JSX.Element | null {
  const live = requested(children)
  const [state, setState] = useState<Generations>(() =>
    live ? { list: [born(live, 1)], next: 2 } : { list: [], next: 1 }
  )
  /** The live element the previous render showed: what a generation shows on its way out. */
  const [shown, setShown] = useState<ReactElement | null>(live)

  // State derived during render (the React pattern for "what did the previous render have"):
  // the request went or changed since the last render, so the live generation starts leaving –
  // frozen at the element it last showed – and a new request is a generation above it.
  const current = state.list.find((g) => !g.leaving) ?? null
  const same = live !== null && current !== null && current.key === live.key
  if (live !== null ? !same : current !== null) {
    const leaving = state.list.map((g) =>
      g.leaving ? g : { ...g, leaving: true, element: shown ?? g.element }
    )
    setState(
      live !== null
        ? { list: [...leaving, born(live, state.next)], next: state.next + 1 }
        : { list: leaving, next: state.next }
    )
  }
  if (shown !== live) setShown(live)

  const drop = useCallback((id: number): void => {
    setState((s) =>
      s.list.some((g) => g.id === id) ? { ...s, list: s.list.filter((g) => g.id !== id) } : s
    )
  }, [])

  if (state.list.length === 0) return null
  return (
    <>
      {state.list.map((g) => (
        <Present key={g.id} id={g.id} leaving={g.leaving} drop={drop}>
          {g.leaving || live === null ? g.element : live}
        </Present>
      ))}
    </>
  )
}

/** One generation: the element and the leave it is told of. */
function Present({
  id,
  leaving,
  drop,
  children
}: {
  id: number
  leaving: boolean
  drop: (id: number) => void
  children: ReactElement
}): JSX.Element {
  const consumers = useRef(0)
  const onLeft = useCallback(() => drop(id), [drop, id])
  const value = useMemo<LeaveSlot>(
    () => ({
      leaving,
      onLeft,
      attach: () => {
        consumers.current++
        return () => {
          consumers.current--
        }
      }
    }),
    [leaving, onLeft]
  )
  // Nothing in the subtree reads the leave: the generation goes with its request, as before.
  useLayoutEffect(() => {
    if (leaving && consumers.current === 0) onLeft()
  }, [leaving, onLeft])
  return <SheetLeaveContext.Provider value={value}>{children}</SheetLeaveContext.Provider>
}
