import { useEffect, useState } from 'react'

/**
 * Copy `text` to the clipboard on `copy`; `copied` stands for a moment after, for the button's
 * "Copied" label (the selection translation's footer).
 */
export function useCopy(text: string | null): { copied: boolean; copy: () => void } {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(timer)
  }, [copied])
  return {
    copied,
    copy: () => {
      if (!text) return
      void navigator.clipboard?.writeText(text).then(
        () => setCopied(true),
        () => undefined
      )
    }
  }
}
