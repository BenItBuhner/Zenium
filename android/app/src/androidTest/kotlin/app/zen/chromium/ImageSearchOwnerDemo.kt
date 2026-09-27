package app.zen.chromium

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PointF
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.net.URLDecoder
import kotlin.math.roundToInt

/**
 * The frame-owner image-search protocol's on-device scene (`internal/parity-services/
 * frame-owner-protocol-interface.md` §7.3; the Kotlin half #605, the services' half #606, both at
 * `v: 1`) on the shared recipe's phone AVD, whose Google APIs image ships WebView 113 – where
 * `WEB_MESSAGE_LISTENER` and `DOCUMENT_START_SCRIPT` hold, so the protocol runs (an older WebView
 * would take the URL-only route throughout, and the scene would say so in its route lines).
 *
 * The gap the protocol closed: the phone's "Search Image with …" once ran `imageFetchScript(src)`
 * in the TOP document's main world, so a page that hooked `window.fetch` or `Image` saw the
 * address of an image a cross-origin frame held. Now the host asks every frame which of them holds
 * the hit-tested address (`zen:image-owner?`, hashes of nonce‖url), asks the owner alone for the
 * thumbnail (`zen:image-thumbnail`), and the owner reads its own `<img>` off its canvas; the top
 * document's script is never handed the address.
 *
 * Four loopback origins, one server each on the drivers' port (any 127.x.y.z is the loopback;
 * the host tells them apart):
 *  - A `127.0.0.1` (the base's server): the TOP documents. Each hooks `window.fetch`, `Image`
 *    (and `HTMLImageElement.prototype.src`), `XMLHttpRequest.prototype.open`,
 *    `Response.prototype.arrayBuffer` (and `blob`), logging every URL seen to `document.title`
 *    and `window.__hookLog`; on load it fetches its own `/ping` through the hooks – the proof
 *    the hooks are live, so an empty log means "nothing was seen", not "nothing was hooked".
 *    It also listens on `__zenPageBridge` (`addEventListener('message')`, as the page script
 *    does – nothing is clobbered) and notes the TYPE of each protocol message the host sent it
 *    (`window.__bridgeLog`), and it keeps what its frame posts up (`window.__frameLog`).
 *  - B `127.0.0.2`: the FRAME document and its image (same-origin to the frame: no CORS needed)
 *    – and the b3 frame, whose image is D's. The frame notes the protocol messages it gets and
 *    posts their types to its parent; it says `loaded WxH` once its image has.
 *  - C `127.0.0.3`: the ENGINE. The seeded profile's default engine is a custom one whose image
 *    search is Google's Lens form (`Search Image with Google Lens`, the row a user sees; Lens's
 *    multipart params and thumbnail bounds) pointed at C: `/upload` (the POST, its body kept)
 *    and `/byurl?url=%s` (the address form). Nothing leaves the device; the real Google is never
 *    named. `sanitizeImageSearchPost` admits plain `http:` on a loopback host alone.
 *  - D `127.0.0.4`: an image with no CORS header, for b3.
 *
 * The variants, each a real hold on the image (a [Finger] press) and a real touch on the row:
 *  b.  HOME (`/`): the framed image (B, same-origin to its frame). (a) the POST landed at C's
 *      `/upload` under `Origin: null` with its `image.jpg` part (encoded_image, image/jpeg, JPEG
 *      bytes), `image_url` the framed image's address, `original_width`/`original_height` its
 *      natural size, and the new tab is the engine's result; (b) the top document's log names NO
 *      URL of origin B – the proof of the fix. Route: the top frame's bridge saw the question and
 *      never the thumbnail ask; the frame saw both.
 *  b2. DELTA (`/delta.html`): the same page with the image in the top document → the search
 *      still works (the main frame is owner: its bridge saw both messages).
 *  b3. GAMMA (`/gamma.html`): the framed image cross-origin to its frame without CORS (D) → the
 *      owner's canvas is tainted and its own fetch refused → `opaque` → the address route: the
 *      new tab is C's `/byurl` with D's address, no POST, and the top log is still empty of B
 *      and D.
 *
 * Findings in `image-search-owner-findings.txt` (one `OK` or `FAIL` per claim; a claim that does
 * not hold fails the run at the end). The seeded profile is the tab-group drivers'
 * (`tab-groups-demo-state.json`) with the engine patched in. Driven by
 * `android-image-search-owner-demo.yml` and by the nightly sweep's phone-d shard
 * (`.github/nightly-drivers/image-search-owner.json`). See [GroupsDemoBase] and [DemoHarness].
 */
@RunWith(AndroidJUnit4::class)
class ImageSearchOwnerDemo : GroupsDemoBase("image-search-owner", "image-search-owner-demo") {
    override val tag = "ImageSearchOwnerDemo"
    override val findingsFile = "image-search-owner-findings.txt"
    override val title = "Zenium Android frame-owner image search (frame-owner-protocol-interface.md §7.3): the owner frame thumbnails its own image, the top document's hooks see no URL of the frame's origin, the upload lands under Origin: null"

    private lateinit var frameSite: DemoServer
    private lateinit var engine: DemoServer
    private lateinit var farSite: DemoServer

    /** A variant of the scene: the top document's tab, where its image lives, what the search should do. */
    private class Variant(
        val id: String,
        val tabId: String,
        val url: String,
        val framed: Boolean,
        val imageUrl: String,
        val upload: Boolean,
        val heading: String
    )

    /** The seeded profile with the fixture's engine as the default (the settings' user engines). */
    override fun patchState(json: String): String {
        val state = JSONObject(json)
        val settings = state.optJSONObject("settings") ?: JSONObject().also { state.put("settings", it) }
        settings.put("searchEngines", JSONArray().put(engineRecord()))
        settings.put("searchEngineId", ENGINE_ID)
        return state.toString()
    }

    @Test
    fun record() {
        val image = jpeg(0xFF1B4332.toInt(), "framed image, origin B")
        val farImage = jpeg(0xFF7B2D26.toInt(), "far image, origin D")
        frameSite = DemoServer(
            PORT,
            mapOf(
                FRAME_PATH to framePage(IMAGE_PATH),
                FRAME_B3_PATH to framePage(FAR_IMAGE_URL),
                IMAGE_PATH to image
            ),
            FRAME_ADDRESS
        ).also { it.start() }
        engine = DemoServer(
            PORT,
            mapOf(
                UPLOAD_PATH to DemoServer.page("Lens upload result", "<p>The fixture engine's answer to the multipart POST.</p>"),
                BYURL_PATH to DemoServer.page("Lens by address", "<p>The fixture engine's answer to the address form.</p>")
            ),
            ENGINE_ADDRESS,
            keepBodies = setOf(UPLOAD_PATH)
        ).also { it.start() }
        farSite = DemoServer(PORT, mapOf(IMAGE_PATH to farImage), FAR_ADDRESS).also { it.start() }
        try {
            recordDemo(
                mapOf(
                    "/" to topPage("Image search owner demo", framedBody(FRAME_URL)),
                    "/delta.html" to topPage("Image search owner demo, image in the top document", inlineBody()),
                    "/gamma.html" to topPage("Image search owner demo, far image", framedBody(FRAME_B3_URL)),
                    IMAGE_PATH to image,
                    PING_PATH to ("text/plain; charset=utf-8" to "pong\n".toByteArray())
                )
            )
        } finally {
            frameSite.close()
            engine.close()
            farSite.close()
        }
    }

    override fun warmUp() {
        head()
        awaitLoaded(HOME, "$ORIGIN/")
        SystemClock.sleep(1_500)
        // The chrome's CSS px against the screen, read once off the bar's Tabs control.
        calibrate("[aria-label^=\"Tabs (\"]", "Tabs (", prefix = true)
        finding("the host: ${webViewPackage()}")
        finding("fixture sites: frame ${frameSite.selfCheck()}; engine ${engine.selfCheck()}; far ${farSite.selfCheck()}")
        finding("the default engine as the core holds it: ${describeEngine()}")
        finding("warm-up done: ${describeSpace()}")
    }

    override fun demo() {
        variant(Variant("b", HOME, "$ORIGIN/", framed = true, imageUrl = FRAME_IMAGE_URL, upload = true, heading = "the framed image (origin B, same-origin to its frame): the owner frame uploads, the top document sees nothing of B"))
        activate(DELTA, "$ORIGIN/delta.html")
        variant(Variant("b2", DELTA, "$ORIGIN/delta.html", framed = false, imageUrl = "$ORIGIN$IMAGE_PATH", upload = true, heading = "the image in the top document: the main frame is the owner and the search still works"))
        activate(GAMMA, "$ORIGIN/gamma.html")
        variant(Variant("b3", GAMMA, "$ORIGIN/gamma.html", framed = true, imageUrl = FAR_IMAGE_URL, upload = false, heading = "the framed image cross-origin to its frame without CORS (origin D): opaque, the address route, the top log still empty"))
        tail()
    }

    // --- one variant ------------------------------------------------------------------------------

    private fun variant(v: Variant) {
        section("${v.id}. §7.3 ${v.heading}")
        ensureForeground()
        val loaded = if (v.framed) {
            awaitUntil(15_000) { frameLog(v.tabId).any { it.startsWith("loaded ") } }
        } else {
            awaitUntil(15_000) { pageJs(v.tabId, "!!(function(){var i=document.getElementById('demo-image');return i&&i.complete&&i.naturalWidth>0})()") == "true" }
        }
        check("${v.id}: the page and its image are loaded", loaded, if (v.framed) "frame said ${frameLog(v.tabId)}" else "the top image is not complete")
        val pinged = awaitUntil(10_000) { hookLog(v.tabId).any { it.contains(PING_URL) } && server.hits(PING_PATH) >= 1 }
        val logBefore = hookLog(v.tabId)
        check("${v.id}: the top document's hooks are live – its own ping went through them and reached the server", pinged, "log $logBefore, ping hits ${server.hits(PING_PATH)}")
        finding("  the top document's log before the hold: $logBefore")
        finding("  the address the old path would have fetched from this document's world: ${v.imageUrl}")
        still("${v.id}-page")
        val target = centreOnScreen(v.tabId, if (v.framed) "demo-frame" else "demo-image") ?: run {
            check("${v.id}: the image is on the screen", false, "no ${if (v.framed) "frame" else "image"} in ${v.tabId} (${describeSpace()})")
            return
        }
        finding("  hold at ${target.x.roundToInt()},${target.y.roundToInt()} on the ${if (v.framed) "framed image (the frame's centre; the image fills the frame)" else "image"}")
        val f = Finger()
        f.press(target.x, target.y)
        f.up()
        val up = awaitJs(MENU_OPEN, true, SHEET_WAIT) && awaitDom(SHEET_ITEM, SHEET_WAIT)
        check("${v.id}: the image's menu comes up as a sheet", up, "menu ${jsText(MENU_OPEN)}")
        if (!up) return
        SystemClock.sleep(600)
        val items = textsOf(SHEET_ITEM)
        finding("  rows as found (${items.size}): $items")
        check("${v.id}: the sheet offers $ROW (the seeded engine's image search, the row a user sees)", ROW in items, "rows $items")
        still("${v.id}-sheet")
        if (ROW !in items) return
        val before = trackOrder().map { it.first }
        val uploadsBefore = engine.hits(UPLOAD_PATH)
        val byUrlBefore = engine.hits(BYURL_PATH)
        val opened = touchUntil(ROW, { textRect(SHEET_ITEM, ROW) }, { trackOrder().size == before.size + 1 }, waitMs = 8_000)
        val newTab = trackOrder().map { it.first }.firstOrNull { it !in before }
        check("${v.id}: the row opens the search's tab beside the page", opened && newTab != null, "new $newTab; ${describeSpace()}")
        check("${v.id}: the sheet is gone after the touch", awaitDomGone(SHEET, SHEET_WAIT), "sheet ${inDom(SHEET)}")
        if (newTab == null) return
        if (v.upload) uploadLanded(v, newTab, uploadsBefore) else addressRoute(v, newTab, uploadsBefore, byUrlBefore)
        SystemClock.sleep(1_000)
        still("${v.id}-result")
        // The top document's words, read in the background where it answers, else brought to
        // the front first (the search's tab is in front now).
        if (hookLog(v.tabId).isEmpty()) {
            finding("  (the top document did not answer in the background: activating it to read its logs)")
            activate(v.tabId, v.url)
        }
        topLog(v)
        route(v)
    }

    /** (a): the POST at the engine's upload endpoint, read off the server's kept request. */
    private fun uploadLanded(v: Variant, newTab: String, uploadsBefore: Int) {
        val landed = awaitUntil(20_000) { engine.hits(UPLOAD_PATH) > uploadsBefore && engine.lastBody(UPLOAD_PATH) != null && tabUrl(newTab) == UPLOAD_URL }
        val method = engine.lastMethod(UPLOAD_PATH)
        val origin = engine.lastHeader(UPLOAD_PATH, "Origin")
        val type = engine.lastHeader(UPLOAD_PATH, "Content-Type") ?: ""
        val body = engine.lastBody(UPLOAD_PATH)?.toString(Charsets.ISO_8859_1) ?: ""
        finding("  the engine's /upload: hits ${engine.hits(UPLOAD_PATH)} (before ${uploadsBefore}), method $method, Origin $origin, Content-Type $type, body ${body.length} bytes, parts ${partNames(body)}")
        check("${v.id} (a): a POST landed at the engine's upload endpoint and the new tab shows its result", landed && method == "POST" && tabUrl(newTab) == UPLOAD_URL, "landed $landed, method $method, tab ${tabUrl(newTab)}")
        check("${v.id} (a): the POST carries Origin: null (the form document under an opaque origin, ImagePostNavigation.FORM_DOCUMENT_BASE)", origin == "null", "Origin $origin")
        check("${v.id} (a): the body is a multipart form", type.startsWith("multipart/form-data; boundary="), "Content-Type $type")
        check(
            "${v.id} (a): the multipart carries the image as the File part image.jpg (encoded_image, image/jpeg, JPEG bytes)",
            body.contains("name=\"encoded_image\"; filename=\"image.jpg\"") && body.contains("Content-Type: image/jpeg") && body.contains("\r\n\r\n\u00FF\u00D8\u00FF"),
            "parts ${partNames(body)}, jpeg magic ${body.contains("\r\n\r\n\u00FF\u00D8\u00FF")}"
        )
        check("${v.id} (a): image_url names the held-on image's own address", partValue(body, "image_url") == v.imageUrl, "image_url ${partValue(body, "image_url")}")
        check(
            "${v.id} (a): original_width / original_height are the image's natural size ${IMAGE_WIDTH}x$IMAGE_HEIGHT – the owner measured its own copy",
            partValue(body, "original_width") == "$IMAGE_WIDTH" && partValue(body, "original_height") == "$IMAGE_HEIGHT",
            "original ${partValue(body, "original_width")}x${partValue(body, "original_height")}, processed ${partValue(body, "processed_image_dimensions")}"
        )
        finding("  sbisrc: ${partValue(body, "sbisrc")}")
    }

    /** b3: the owner said `opaque`, so the row took the address form – no POST, the engine's URL page. */
    private fun addressRoute(v: Variant, newTab: String, uploadsBefore: Int, byUrlBefore: Int) {
        val landed = awaitUntil(20_000) { engine.hits(BYURL_PATH) > byUrlBefore && (tabUrl(newTab)?.startsWith("$BYURL_URL?") == true) }
        val url = tabUrl(newTab) ?: ""
        val carried = url.substringAfter("?url=", "").substringBefore('&').let { runCatching { URLDecoder.decode(it, "UTF-8") }.getOrDefault(it) }
        finding("  the engine's /byurl: hits ${engine.hits(BYURL_PATH)} (before $byUrlBefore), method ${engine.lastMethod(BYURL_PATH)}; the new tab's address $url")
        check("${v.id} (b3): the address route opens the engine's URL form with the far image's address (the owner's canvas is tainted and its own fetch refused: opaque)", landed && url.startsWith("$BYURL_URL?url=") && carried == v.imageUrl, "landed $landed, url $url, carried $carried")
        check("${v.id} (b3): no upload was posted", engine.hits(UPLOAD_PATH) == uploadsBefore, "upload hits ${engine.hits(UPLOAD_PATH)}, before $uploadsBefore")
    }

    /** (b): the top document's log, read after the search: nothing of the frame's origin. */
    private fun topLog(v: Variant) {
        val log = hookLog(v.tabId)
        val title = pageTitle(v.tabId)
        val coreTitle = coreState().getJSONObject("tabs").optJSONObject(v.tabId)?.optString("title")
        finding("  the top document's log after the search (${log.size}): $log")
        finding("  the top document's title: '$title'; the core's title for the tab: '$coreTitle'")
        val foreign = log.filter { it.contains(FRAME_HOST) || it.contains(FAR_HOST) }
        if (v.framed) {
            check(
                "${v.id} (b): the top document's log names NO URL of the frame's origin ${frameSite.origin}${if (v.upload) "" else " nor of the far image's ${farSite.origin}"} – the hooked fetch / Image / XHR / arrayBuffer saw nothing of the framed image",
                log.isNotEmpty() && foreign.isEmpty(),
                "foreign $foreign, log $log"
            )
            check("${v.id} (b): the title carries the log and names no frame URL either", title.startsWith("LOG ") && !title.contains(FRAME_HOST) && !title.contains(FAR_HOST), "title '$title'")
        } else {
            finding("  (b2) the owner is the top document itself: its hooks saw ${log.filter { it.contains(IMAGE_PATH) }.size} request(s) of its image (the owner reads its own <img> off the canvas, no request; a read of its own address would be its own business)")
            check("${v.id} (b2): the log holds the ping and nothing of another origin", log.isNotEmpty() && foreign.isEmpty(), "foreign $foreign, log $log")
        }
    }

    /** The route the search took, off the protocol messages the frames noted (not off host logs: #605 has none). */
    private fun route(v: Variant) {
        val bridge = bridgeLog(v.tabId)
        val frame = frameLog(v.tabId).filter { !it.startsWith("loaded ") }
        finding("  protocol messages the top frame's bridge saw: $bridge${if (v.framed) "; the frame's: $frame" else ""}")
        if (v.framed) {
            check("${v.id}: the host asked the top frame (zen:image-owner?) and never asked it for the thumbnail – it is not the owner", QUESTION in bridge && THUMBNAIL !in bridge, "top $bridge")
            check("${v.id}: the frame was asked and then asked for the thumbnail – the owner-frame route, not the URL-only fallback", QUESTION in frame && THUMBNAIL in frame, "frame $frame")
        } else {
            check("${v.id}: the top frame – the image's holder – was asked and then asked for the thumbnail (the main frame is the owner)", QUESTION in bridge && THUMBNAIL in bridge, "top $bridge")
        }
    }

    // --- the pages' words -----------------------------------------------------------------------

    /** `window.__hookLog` of the top document in [tabId]: every URL its hooks saw. */
    private fun hookLog(tabId: String): List<String> = pageStrings(tabId, "window.__hookLog")

    /** `window.__bridgeLog`: the types of the protocol messages the top frame's bridge received. */
    private fun bridgeLog(tabId: String): List<String> = pageStrings(tabId, "window.__bridgeLog")

    /** `window.__frameLog`: what the frame posted to its parent (`loaded WxH`, then message types). */
    private fun frameLog(tabId: String): List<String> = pageStrings(tabId, "window.__frameLog")

    private fun pageStrings(tabId: String, expression: String): List<String> {
        val raw = pageJs(tabId, "JSON.stringify($expression||null)")
        val text = runCatching { JSONTokener(raw).nextValue() as? String }.getOrNull() ?: return emptyList()
        val array = runCatching { JSONArray(text) }.getOrNull() ?: return emptyList()
        return (0 until array.length()).map { array.optString(it) }
    }

    private fun pageTitle(tabId: String): String {
        val raw = pageJs(tabId, "document.title")
        return runCatching { JSONTokener(raw).nextValue() as? String }.getOrNull().orEmpty()
    }

    /** Where the element `id` of the page in [tabId] is on the screen, its centre (see [linkOnScreen]). */
    private fun centreOnScreen(tabId: String, id: String): PointF? {
        val host = (activity as MainActivity).host
        val raw = pageJs(
            tabId,
            "(function(){var e=document.getElementById(${JSONObject.quote(id)});if(!e)return null;var r=e.getBoundingClientRect();" +
                "var d=window.devicePixelRatio;return JSON.stringify([(r.left+r.width/2)*d,(r.top+r.height/2)*d])})()"
        )
        val text = runCatching { JSONTokener(raw).nextValue() as? String }.getOrNull() ?: return null
        val a = runCatching { JSONArray(text) }.getOrNull() ?: return null
        val origin = IntArray(2)
        var shown = false
        instrumentation.runOnMainSync {
            val view = host.tabs.get(tabId)
            if (view != null) {
                view.getLocationOnScreen(origin)
                shown = view.isShown
            }
        }
        if (!shown) return null
        return PointF(origin[0] + a.getDouble(0).toFloat(), origin[1] + a.getDouble(1).toFloat())
    }

    /** The core activates [tabId] (a touch on its card is the overview drivers' business), its page loaded. */
    private fun activate(tabId: String, url: String) {
        coreInvoke("tab.activate", "{\"tabId\":${JSONObject.quote(tabId)}}")
        val active = awaitCore { activeTabId(it) == tabId }
        awaitLoaded(tabId, url)
        SystemClock.sleep(1_500)
        finding("  $tabId activated: $active; ${describeSpace()}")
    }

    private fun describeEngine(): String = runCatching {
        val settings = coreState().getJSONObject("settings")
        val id = settings.optString("searchEngineId")
        val engines = settings.optJSONArray("searchEngines") ?: JSONArray()
        val own = (0 until engines.length()).map { engines.getJSONObject(it) }.firstOrNull { it.optString("id") == id }
        val image = own?.optJSONObject("imageSearch")
        "searchEngineId '$id'; the engine ${own?.optString("name")}; imageSearch '${image?.optString("name")}' url ${image?.optString("url")} post ${image?.optJSONObject("post")?.optString("url")} (${image?.optJSONObject("post")?.optString("encoding")})"
    }.getOrElse { "not readable: $it" }

    private fun webViewPackage(): String =
        shellCommand("dumpsys webviewupdate").lines().firstOrNull { it.contains("Current WebView package") }?.trim() ?: "WebView package ?"

    companion object {
        private const val FRAME_ADDRESS = "127.0.0.2"
        private const val ENGINE_ADDRESS = "127.0.0.3"
        private const val FAR_ADDRESS = "127.0.0.4"
        private const val FRAME_ORIGIN = "http://$FRAME_ADDRESS:$PORT"
        private const val ENGINE_ORIGIN = "http://$ENGINE_ADDRESS:$PORT"
        private const val FAR_ORIGIN = "http://$FAR_ADDRESS:$PORT"
        private const val FRAME_HOST = "$FRAME_ADDRESS:$PORT"
        private const val FAR_HOST = "$FAR_ADDRESS:$PORT"

        private const val FRAME_PATH = "/frame.html"
        private const val FRAME_B3_PATH = "/frame-far.html"
        private const val IMAGE_PATH = "/image.jpg"
        private const val PING_PATH = "/ping"
        private const val UPLOAD_PATH = "/upload"
        private const val BYURL_PATH = "/byurl"
        private const val FRAME_URL = "$FRAME_ORIGIN$FRAME_PATH"
        private const val FRAME_B3_URL = "$FRAME_ORIGIN$FRAME_B3_PATH"
        private const val FRAME_IMAGE_URL = "$FRAME_ORIGIN$IMAGE_PATH"
        private const val FAR_IMAGE_URL = "$FAR_ORIGIN$IMAGE_PATH"
        private const val PING_URL = "$ORIGIN$PING_PATH"
        private const val UPLOAD_URL = "$ENGINE_ORIGIN$UPLOAD_PATH"
        private const val BYURL_URL = "$ENGINE_ORIGIN$BYURL_PATH"

        private const val ENGINE_ID = "lens-fixture"
        /** The row's words: `Search Image with ${imageSearch.name}` (menus.ts), the name Google's own engine gives its form. */
        private const val ROW = "Search Image with Google Lens"
        private const val QUESTION = "zen:image-owner?"
        private const val THUMBNAIL = "zen:image-thumbnail"
        private const val SHEET = ".zen-sheet"
        private const val SHEET_ITEM = ".zen-sheet .zen-sheet-item"

        /** The image's natural size: within Lens's bounds (1000 px, 300x300 area), so the thumbnail is the image itself. */
        private const val IMAGE_WIDTH = 400
        private const val IMAGE_HEIGHT = 300

        /**
         * The fixture's engine: Google's Lens form (`DEFAULT_SEARCH_ENGINES[google].imageSearch`,
         * the `image_url_post_params` of Chromium's `prepopulated_engines.json` and
         * `LENS_IMAGE_THUMBNAIL`) with C's endpoints in place of Lens's. A shipped id would be
         * dropped by `sanitizeSearchEngines`; the id is the fixture's own.
         */
        private fun engineRecord(): JSONObject = JSONObject()
            .put("id", ENGINE_ID)
            .put("name", "Lens fixture")
            .put("searchUrl", "$ENGINE_ORIGIN/search?q=%s")
            .put("keyword", "@lensfixture")
            .put("glyph", "L")
            .put("source", "custom")
            .put(
                "imageSearch",
                JSONObject()
                    .put("name", "Google Lens")
                    .put("url", "$BYURL_URL?url=%s")
                    .put(
                        "post",
                        JSONObject()
                            .put("url", UPLOAD_URL)
                            .put(
                                "params",
                                "encoded_image={imageThumbnail},image_url={imageURL},sbisrc={imageSearchSource},original_width={imageOriginalWidth},original_height={imageOriginalHeight},processed_image_dimensions={processedImageDimensions}"
                            )
                            .put("encoding", "multipart")
                            .put("thumbnail", JSONObject().put("maxSide", 1000).put("minArea", 300 * 300))
                    )
            )

        /** The part names of a multipart body, for the findings. */
        private fun partNames(body: String): List<String> =
            Regex("name=\"([^\"]+)\"").findAll(body).map { it.groupValues[1] }.toList()

        /** The value of the text part `name` of a multipart body; null when there is none. */
        private fun partValue(body: String, name: String): String? {
            val marker = "name=\"$name\"\r\n\r\n"
            val at = body.indexOf(marker)
            if (at < 0) return null
            val start = at + marker.length
            val end = body.indexOf("\r\n--", start)
            return if (end < 0) null else body.substring(start, end)
        }

        /** A JPEG of [IMAGE_WIDTH]x[IMAGE_HEIGHT]: a flat colour and a caption, so a still tells the images apart. */
        private fun jpeg(colour: Int, caption: String): Pair<String, ByteArray> {
            val bitmap = Bitmap.createBitmap(IMAGE_WIDTH, IMAGE_HEIGHT, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bitmap)
            canvas.drawColor(colour)
            val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = 0xFFFFFFFF.toInt()
                textSize = 30f
            }
            canvas.drawText(caption, 24f, IMAGE_HEIGHT / 2f, paint)
            val out = ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.JPEG, 90, out)
            bitmap.recycle()
            return "image/jpeg" to out.toByteArray()
        }

        /**
         * The hooks of §7.3, installed before anything else in the document: every URL that
         * `fetch`, `Image` (`HTMLImageElement.prototype.src`), `XMLHttpRequest.prototype.open`
         * and `Response.prototype.arrayBuffer` / `blob` see goes to the title and `__hookLog`;
         * the bridge's protocol messages are noted by type; the frame's words are kept; the
         * document's own ping through the hooks proves them live. No `$` in the script: it is
         * a Kotlin template.
         */
        private const val HOOKS = """
            (function(){
              var log=[],types=[],frame=[];
              window.__hookLog=log;window.__bridgeLog=types;window.__frameLog=frame;
              function note(kind,u){try{u=String(u)}catch(e){u='?'}log.push(kind+' '+u);document.title='LOG '+log.length+': '+log.join(' | ')}
              var F=window.fetch;window.fetch=function(input,init){note('fetch',(input&&input.url)||input);return F.apply(this,arguments)};
              var O=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){note('xhr',u);return O.apply(this,arguments)};
              var AB=Response.prototype.arrayBuffer;Response.prototype.arrayBuffer=function(){note('arrayBuffer',this.url);return AB.apply(this,arguments)};
              var BL=Response.prototype.blob;Response.prototype.blob=function(){note('blob',this.url);return BL.apply(this,arguments)};
              var d=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
              if(d&&d.set){Object.defineProperty(HTMLImageElement.prototype,'src',{configurable:true,enumerable:d.enumerable,get:d.get,set:function(v){note('img.src',v);return d.set.call(this,v)}})}
              var I=window.Image;window.Image=function(w,h){note('Image','constructed');return new I(w,h)};window.Image.prototype=I.prototype;
              var b=window.__zenPageBridge;
              if(b&&typeof b.addEventListener==='function'){b.addEventListener('message',function(e){var t='?';try{t=JSON.parse(e.data).type||'?'}catch(x){}types.push(t)})}
              window.addEventListener('message',function(e){if(e.data&&typeof e.data.zenDemoFrame==='string')frame.push(e.data.zenDemoFrame)});
              window.addEventListener('load',function(){fetch(location.origin+'/ping').catch(function(){})});
            })();
        """

        /** A top document (origin A): the hooks first, then a heading and [body]. */
        private fun topPage(title: String, body: String): Pair<String, ByteArray> =
            "text/html; charset=utf-8" to (
                "<!doctype html><html><head><meta charset=utf-8>" +
                    "<meta name=viewport content=\"width=device-width,initial-scale=1\"><title>$title</title>" +
                    "<script>${HOOKS.trimIndent()}</script>" +
                    "<style>body{margin:0;font-family:sans-serif;color:#15141a}h1{font-size:24px;padding:32px 24px 8px}" +
                    "p{padding:0 24px;font-size:18px}iframe,img{display:block;margin:16px 24px;border:0}</style></head>" +
                    "<body><h1>$title</h1>$body</body></html>"
                ).toByteArray()

        /** The cross-origin frame (origin B) at a known size; its image fills it, so the frame's centre is the image's. */
        private fun framedBody(frameUrl: String): String =
            "<p>The image below is held by a cross-origin frame.</p>" +
                "<iframe id=\"demo-frame\" src=\"$frameUrl\" width=\"280\" height=\"200\"></iframe>" +
                "<p>Hold the image for its menu.</p>"

        /** The image in the top document itself (b2). */
        private fun inlineBody(): String =
            "<p>The image below is the top document's own.</p>" +
                "<img id=\"demo-image\" src=\"$IMAGE_PATH\" width=\"280\" height=\"200\" alt=\"the image\">" +
                "<p>Hold the image for its menu.</p>"

        /**
         * The frame document (origin B): one image at [imageUrl] filling the viewport, no hooks
         * of its own; it notes the protocol messages its bridge gets and posts their types to the
         * parent, and says `loaded WxH` once the image has (its natural size is readable across
         * origins).
         */
        private fun framePage(imageUrl: String): Pair<String, ByteArray> =
            "text/html; charset=utf-8" to (
                "<!doctype html><html><head><meta charset=utf-8>" +
                    "<style>html,body{margin:0;height:100%;background:#ddd}img{display:block;width:100%;height:100%;object-fit:cover}</style>" +
                    "<script>(function(){var b=window.__zenPageBridge;var up=function(t){try{parent.postMessage({zenDemoFrame:t},'*')}catch(x){}};" +
                    "if(b&&typeof b.addEventListener==='function'){b.addEventListener('message',function(e){var t='?';try{t=JSON.parse(e.data).type||'?'}catch(x){}up(t)})}" +
                    "window.addEventListener('load',function(){var i=document.getElementById('framed');up('loaded '+(i?i.naturalWidth+'x'+i.naturalHeight:'?'))})})();</script>" +
                    "</head><body><img id=\"framed\" src=\"$imageUrl\" alt=\"the framed image\"></body></html>"
                ).toByteArray()
    }
}
