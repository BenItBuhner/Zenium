import type { HostCapabilities } from '@shared/types'
import type { ViewportInfo } from './formFactor'

/**
 * Which steps the first run shows. Pure over the host's capabilities and the viewport, so the
 * tour can be reasoned about (and tested) without rendering it: a step about sync is only shown
 * where sync exists, and keyboard shortcuts are only taught where a keyboard is likely.
 */

export type TourStep =
  'welcome' | 'look' | 'search' | 'essentials' | 'features' | 'sync' | 'shortcuts'

export type TourFeature = 'spaces' | 'compact' | 'glance' | 'boosts' | 'livefolders' | 'sync'

/** Capabilities that shape the tour (a subset of `HostCapabilities`). */
export type TourCapabilities = Pick<HostCapabilities, 'sync'>

/**
 * A host driven by fingers alone: coarse pointer and nothing that hovers. A tablet with a
 * trackpad or a phone in DeX brings hover back and counts as keyboard-equipped; a hardware
 * keyboard on its own cannot be detected from the web platform, so a keyboard-only tablet is
 * treated as touch-only and finds the shortcuts in Settings instead.
 */
export function isTouchOnly(viewport: Pick<ViewportInfo, 'coarse' | 'hover'>): boolean {
  return viewport.coarse && !viewport.hover
}

/** The desktop tour: seven steps, minus sync without the capability, minus shortcuts on touch. */
export function tourSteps(caps: TourCapabilities, touchOnly: boolean): TourStep[] {
  const steps: TourStep[] = ['welcome', 'look', 'search', 'essentials', 'features']
  if (caps.sync) steps.push('sync')
  if (!touchOnly) steps.push('shortcuts')
  return steps
}

/**
 * The feature cards of the tour. Compact Mode (hover to reveal) and Glance (a modifier click)
 * need a pointer and a keyboard; Sync needs the host to have it.
 */
export function tourFeatures(caps: TourCapabilities, touchOnly: boolean): TourFeature[] {
  const features: TourFeature[] = ['spaces']
  if (!touchOnly) features.push('compact', 'glance')
  features.push('boosts', 'livefolders')
  if (caps.sync) features.push('sync')
  return features
}
