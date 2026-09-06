import type { JSX } from 'react'
import type { Mod } from '@shared/types'

/** Injects every enabled Mod's CSS into the chrome document (Zen's `chrome.css` mods). */
export function ModStyles({ mods }: { mods: Mod[] }): JSX.Element | null {
  const enabled = mods.filter((m) => m.enabled && m.css.trim())
  if (enabled.length === 0) return null
  return (
    <>
      {enabled.map((m) => (
        <style key={m.id} data-zen-mod={m.id}>
          {m.css}
        </style>
      ))}
    </>
  )
}
