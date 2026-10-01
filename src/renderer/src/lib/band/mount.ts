import { useEffect, useSyncExternalStore } from 'react'
import { bandStore, dismissBand } from '@renderer/lib/band'
import { createAndroidBandHost, type AndroidBandHost } from './androidHost'
import { createModelDoor } from './door'
import { setBandDoor } from './post'

/**
 * The band's Android wiring in one place: the host over the pull channel (the seam the shared
 * motion driver writes to, and the model's word on the front) and the tenants' door onto the
 * model. The touch shell mounts it with the band's layer and unmounts it with the layer, so the
 * four prompts are the band's only while a band can show them – with the layer gone they go to
 * the banner stack again, as before, and whatever stood at the band is taken down as the
 * chrome's doing (`program`) so each tenant hears its end and lets go of its post.
 */
export interface AndroidBand {
  /** The seam the band's layer hands its motion driver. */
  host: AndroidBandHost
  unmount(): void
}

/** The band mounted right now (one touch shell at a time), for {@link useAndroidBand}'s readers. */
let current: AndroidBand | null = null
const readers = new Set<() => void>()

function publish(): void {
  for (const reader of readers) reader()
}

function subscribeMounted(reader: () => void): () => void {
  readers.add(reader)
  return () => {
    readers.delete(reader)
  }
}

export function mountAndroidBand(): AndroidBand {
  const host = createAndroidBandHost()
  setBandDoor(createModelDoor())
  const band: AndroidBand = {
    host,
    unmount: () => {
      for (const entry of bandStore.get().entries) dismissBand(entry.id, 'program')
      setBandDoor(null)
      host.release()
      if (current === band) {
        current = null
        publish()
      }
    }
  }
  current = band
  publish()
  return band
}

/** The band mounted right now, or null. */
export function mountedAndroidBand(): AndroidBand | null {
  return current
}

/**
 * React: the band mounted for the calling shell's lifetime; its host – the seam the band's
 * layer takes – once the mount has run, null on the first render.
 */
export function useAndroidBand(): AndroidBandHost | null {
  useEffect(() => {
    const band = mountAndroidBand()
    return () => band.unmount()
  }, [])
  return useSyncExternalStore(
    subscribeMounted,
    () => current?.host ?? null,
    () => null
  )
}
