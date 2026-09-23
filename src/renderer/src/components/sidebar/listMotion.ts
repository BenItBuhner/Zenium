import { createContext, useContext } from 'react'
import type { SlideMotion } from '@renderer/lib/motion/slide'

/**
 * The motion of the tab list a row is rendered in (see lib/motion/slide.ts): the panel owns it
 * and the rows attach their elements to it, so a lifted row's neighbours can slide and rows
 * whose slot moved can spring there after a commit.
 */
export const ListMotionContext = createContext<SlideMotion | null>(null)

export function useListMotion(): SlideMotion | null {
  return useContext(ListMotionContext)
}

/** More rows than this arriving in one commit is a restore, placed without motion. */
export const ENTER_BATCH = 6
