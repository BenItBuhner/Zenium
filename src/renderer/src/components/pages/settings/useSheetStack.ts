import { useCallback, useMemo, useState } from 'react'
import type { RowContext, SheetRequest } from './rows'

/**
 * The page keeps a stack of at most two sheet requests (v2 §9.24: a sheet may open one sheet,
 * and that one opens nothing). A third request replaces the top one.
 */
export const MAX_SHEET_DEPTH = 2

/** The page's sheet stack: what is open, the context rows open sheets through, and the closers. */
export function useSheetStack(): {
  requests: SheetRequest[]
  ctx: RowContext
  closeTop(): void
  closeAll(): void
} {
  const [requests, setRequests] = useState<SheetRequest[]>([])
  const ctx = useMemo<RowContext>(
    () => ({
      open: (request) =>
        setRequests((stack) =>
          stack.length >= MAX_SHEET_DEPTH
            ? [...stack.slice(0, MAX_SHEET_DEPTH - 1), request]
            : [...stack, request]
        )
    }),
    []
  )
  const closeTop = useCallback(() => setRequests((stack) => stack.slice(0, -1)), [])
  const closeAll = useCallback(() => setRequests([]), [])
  return { requests, ctx, closeTop, closeAll }
}
