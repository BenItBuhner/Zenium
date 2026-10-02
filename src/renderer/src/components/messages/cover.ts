import { useSyncExternalStore } from 'react'
import { isTouchLayout, viewportStore } from '@renderer/lib/formFactor'
import { overviewIsOpen, stageStore } from '@renderer/lib/gestures/stage'

/**
 * Whether the open tab overview covers the banner stack (§9.33, matrix row A4): a touch layout
 * (`isTouchLayout()`: the phone's and the tablet's, the layouts with a stage) with the overview
 * anywhere but closed – from its first dragging frame to its close, the band's reading
 * (`lib/band/signals.ts`, the stage's `overviewIsOpen()`; one definition, not a second). The
 * desktop has no stage and reads false whatever the stage store says.
 */
export function bannerStackCovered(): boolean {
  return isTouchLayout() && overviewIsOpen()
}

function subscribe(onChange: () => void): () => void {
  // The stage publishes every frame of the overview's drag and settle; the snapshot is the one
  // flip, so the surface re-renders on the flip alone (`useSyncExternalStore` compares them).
  const offStage = stageStore.subscribe(onChange)
  const offViewport = viewportStore.subscribe(onChange)
  return () => {
    offStage()
    offViewport()
  }
}

/** `bannerStackCovered()` for the surface that draws the stack: re-renders on the flip only. */
export function useBannerStackCovered(): boolean {
  return useSyncExternalStore(subscribe, bannerStackCovered, bannerStackCovered)
}
