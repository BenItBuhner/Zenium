package app.zen.chromium.ext

import java.util.WeakHashMap

/**
 * Whose request a tab's request for an extension's file is, where WebView hands the embedder no
 * initiator: the extension's own frame in the tab, or the tab's web page.
 *
 * Chrome serves a web page the extension's `web_accessible_resources` only and the extension's
 * own documents any file, told apart by the request's initiator. `shouldInterceptRequest` sees
 * the URL, the main-frame flag and the request headers (no `Sec-Fetch-Site`), so the gate in
 * [Extensions] reads the requester off the `Referer`: the extension's origin for a frame's own
 * requests, the page's for the page's. A frame document under
 * `<meta name="referrer" content="no-referrer">` sends none for its scripts, stylesheets and
 * fonts, which then read as a web page's and were refused – Search by Image's select, confirm
 * and capture views (compat round 19: the view loaded as an empty shell, never connected its
 * port to the content script, and the content script queued the picked image for it without a
 * word; every `dessant` extension's views carry the meta).
 *
 * Two readings the referrer policy does not touch, for the gate to add to the Referer's:
 * - a CORS request (a font, a module script, a `fetch`) carries the requesting document's
 *   `Origin`; one naming the extension's own origin is the extension's document's, since a web
 *   page cannot claim it ([ownRequest]'s first clause);
 * - a request with no Referer at all, for a file that is not a document, from a tab whose page
 *   holds a frame document of the extension – noted when one of its web-accessible pages, the
 *   only kind a foreign page may embed, is served into a frame of the tab ([framed]), forgotten
 *   with the page at the tab's next main-frame request ([forget]). A web page's own requests
 *   carry its Referer unless it suppresses referrers too; a page that does may then, while the
 *   extension's frame is in it, read files of the extension that are not web-accessible – never
 *   load a document of it, which stays behind the list as Chrome keeps it.
 *
 * Pure bookkeeping, generic over the tab so it runs under JUnit; the intercept threads note and
 * ask, so every entry point is synchronized. Keys are held weakly: a tab that is gone takes its
 * notes with it.
 */
class FrameOwnership<T : Any> {
    private val framedIn = WeakHashMap<T, MutableSet<String>>()

    /** A frame document of extension [id] was served into [tab]'s page. */
    @Synchronized
    fun framed(tab: T, id: String) {
        framedIn.getOrPut(tab) { HashSet() }.add(id)
    }

    /** [tab]'s page is going (a main-frame request): its frames go with it. */
    @Synchronized
    fun forget(tab: T) {
        framedIn.remove(tab)
    }

    /** Whether [tab]'s page holds a frame document of extension [id]. */
    @Synchronized
    fun holds(tab: T, id: String): Boolean = framedIn[tab]?.contains(id) == true

    /** Everything forgotten (the runtime's reset). */
    @Synchronized
    fun clear() {
        framedIn.clear()
    }

    /**
     * Whether a request from [tab] for a file of extension [id] – whose origin is
     * [extensionOrigin], `https://<id>.ext.zenium.invalid` with no trailing slash, as an `Origin`
     * header spells it – is the extension's own document's rather than the tab's page's: by the
     * request's `Origin` header naming the extension, or, with no Referer ([referer] null) and
     * not for a document ([isDocument] false), by a frame of the extension in the tab. A request
     * carrying a Referer is the caller's to read; this answers false for it unless its `Origin`
     * is the extension's.
     */
    fun ownRequest(tab: T, id: String, extensionOrigin: String, referer: String?, originHeader: String?, isDocument: Boolean): Boolean =
        (originHeader != null && originHeader == extensionOrigin) || (referer == null && !isDocument && holds(tab, id))
}
