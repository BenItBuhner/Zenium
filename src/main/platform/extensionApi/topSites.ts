import { ApiError, type ApiContext, type ApiHost, type NamespaceHandlers } from './types'

/** Chrome's most-visited list holds this many sites. */
export const TOP_SITES_COUNT = 20

export const ERROR_NO_PERMISSION = "The extension does not have the 'topSites' permission."

export interface MostVisitedUrl {
  url: string
  title: string
}

/**
 * `chrome.topSites` over the history model's frecency ranking (`HistoryService.topSites`, owned
 * by the history program): one entry per host, the best-scoring page standing for it, as the
 * `zen://blank` page shows them.
 */
export class TopSitesApi {
  constructor(private readonly host: ApiHost) {}

  readonly handlers: NamespaceHandlers = {
    get: (ctx) => this.get(ctx)
  }

  private get(ctx: ApiContext): MostVisitedUrl[] {
    if (!this.host.grants(ctx.extensionId).permissions.includes('topSites'))
      throw new ApiError(ERROR_NO_PERMISSION)
    return this.host.browser.history
      .topSites(TOP_SITES_COUNT)
      .map(({ url, title }) => ({ url, title: title || url }))
  }
}
