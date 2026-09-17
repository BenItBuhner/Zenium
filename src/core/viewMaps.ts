/**
 * Live-page maps owned by `TabManager`. The host can destroy a view (window close, renderer
 * gone) after or before `destroyView`; both paths must forget the same records.
 */
export interface LiveViewMaps<V> {
  views: Map<string, V>
  owners: Map<string, unknown>
  extras?: Array<{ delete: (key: string) => unknown }>
}

/**
 * Drop a tab's live page from the owner maps. Idempotent so explicit teardown and the host's
 * `onDestroyed` can run in either order without throwing on a missing record.
 */
export function forgetViewRecord<V>(tabId: string, maps: LiveViewMaps<V>): V | undefined {
  const view = maps.views.get(tabId)
  if (view === undefined) return undefined
  maps.views.delete(tabId)
  maps.owners.delete(tabId)
  for (const extra of maps.extras ?? []) extra.delete(tabId)
  return view
}
