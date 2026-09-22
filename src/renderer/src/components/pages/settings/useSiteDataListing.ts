import { useEffect, useRef, useState } from 'react'
import type { SiteDataListing, SiteDataOriginRow } from '@shared/siteData'
import { cmd } from '@renderer/lib/api'

/**
 * The site-data listing as the viewer shows it on either host – the desktop dialog's rows
 * (`SiteDataViewer.tsx`) and the phone page's (`SiteDataPage.tsx`) read the same reading and
 * run the same clears, and differ only in how the rows are drawn. It asks the engine once
 * (`siteData.list`: every origin with cookies, stored data or a permission, the most data first,
 * capped at 1 000) and keeps what the clears do to it: an origin the engine is clearing (the
 * §9.30 busy control), one it refused (the row stays, with the failure line in the danger ink),
 * the row leaving the listing once cleared with the total following it, and Clear all's own
 * busy and failure, which empty the listing or leave it whole.
 */
export interface SiteDataListingState {
  /** The engine's reading; null until it has answered. */
  listing: SiteDataListing | null
  /** The engine did not answer the reading. */
  failed: boolean
  /** The listing's rows, none until the reading is in. */
  rows: readonly SiteDataOriginRow[]
  /** Origins whose clear the engine is running. */
  clearing: ReadonlySet<string>
  /** Origins whose clear the engine refused. */
  refused: ReadonlySet<string>
  clearingAll: boolean
  allFailed: boolean
  clearSite(origin: string): void
  clearAll(): void
}

export function useSiteDataListing(): SiteDataListingState {
  const [listing, setListing] = useState<SiteDataListing | null>(null)
  const [failed, setFailed] = useState(false)
  const [clearing, setClearing] = useState<ReadonlySet<string>>(new Set())
  const [refused, setRefused] = useState<ReadonlySet<string>>(new Set())
  const [clearingAll, setClearingAll] = useState(false)
  const [allFailed, setAllFailed] = useState(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    cmd('siteData.list', undefined).then(
      (result) => {
        if (alive.current) setListing(result)
      },
      () => {
        if (alive.current) setFailed(true)
      }
    )
    return () => {
      alive.current = false
    }
  }, [])

  const clearSite = (origin: string): void => {
    if (clearing.has(origin)) return
    setClearing((set) => new Set(set).add(origin))
    setRefused((set) => without(set, origin))
    cmd('siteData.clearSite', { origin }).then(
      () => {
        if (!alive.current) return
        setClearing((set) => without(set, origin))
        setListing((current) => current && withoutRow(current, origin))
      },
      () => {
        if (!alive.current) return
        setClearing((set) => without(set, origin))
        setRefused((set) => new Set(set).add(origin))
      }
    )
  }
  const clearAll = (): void => {
    if (clearingAll) return
    setClearingAll(true)
    setAllFailed(false)
    cmd('siteData.clearAll', undefined).then(
      () => {
        if (!alive.current) return
        setClearingAll(false)
        setRefused(new Set())
        setListing((current) =>
          current ? { rows: [], total: 0, truncated: false, sized: current.sized } : current
        )
      },
      () => {
        if (!alive.current) return
        setClearingAll(false)
        setAllFailed(true)
      }
    )
  }

  return {
    listing,
    failed,
    rows: listing?.rows ?? [],
    clearing,
    refused,
    clearingAll,
    allFailed,
    clearSite,
    clearAll
  }
}

function without(set: ReadonlySet<string>, item: string): ReadonlySet<string> {
  if (!set.has(item)) return set
  const next = new Set(set)
  next.delete(item)
  return next
}

/** The listing with one origin gone: the total follows, the cap's line with it once under it. */
function withoutRow(listing: SiteDataListing, origin: string): SiteDataListing {
  const rows = listing.rows.filter((row) => row.origin !== origin)
  if (rows.length === listing.rows.length) return listing
  const total = Math.max(rows.length, listing.total - 1)
  return { ...listing, rows, total, truncated: listing.truncated && total > rows.length }
}
