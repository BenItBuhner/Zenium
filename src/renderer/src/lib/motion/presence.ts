import { useEffect, useState } from 'react'
import { reducedMotion } from './spring'

/**
 * Keeps a surface mounted for its exit animation. While `value` is set it is returned as is;
 * when it goes null the last value stays for `exitMs` with `exiting: true`, so the component can
 * play its pop backwards before it leaves. A new value during the exit cancels it.
 */
export function usePresence<T>(
  value: T | null,
  exitMs: number
): { value: T | null; exiting: boolean } {
  const [prev, setPrev] = useState(value)
  const [gone, setGone] = useState<T | null>(null)
  if (value !== prev) {
    setPrev(value)
    if (value === null) setGone(prev)
    else if (gone !== null) setGone(null)
  }
  useEffect(() => {
    if (gone === null) return
    const t = setTimeout(() => setGone(null), reducedMotion() ? 0 : exitMs)
    return () => clearTimeout(t)
  }, [gone, exitMs])
  if (value !== null) return { value, exiting: false }
  return { value: gone, exiting: gone !== null }
}

/** The desktop pop's length (§7): panels come in over it and leave over it. */
export const POP_MS = 180
