package app.zen.chromium

import android.app.PendingIntent
import android.app.SearchManager
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.IntentSender
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.service.chooser.ChooserAction
import android.util.Base64
import android.webkit.CookieManager
import android.widget.ImageView
import android.widget.Toast
import androidx.annotation.RequiresApi
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.content.IntentCompat
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executor

/**
 * Both directions of sharing. Out: the core's `app.share` becomes the system share sheet with a
 * link preview (title and favicon), Zenium's own action row on Android 14 (Copy link, QR code,
 * Screenshot, Print), or an image handed over as a file. In: another app's `ACTION_SEND` or
 * `ACTION_WEB_SEARCH` is described to the core, which routes it to a tab, a search with the
 * user's engine, or an image page.
 */
class Share(private val host: Host, private val io: Executor) {
    private val activity get() = host.activity
    private val main = Handler(Looper.getMainLooper())

    // --- out: the share sheet ----------------------------------------------------------------------

    /**
     * `app.share`: a link, text, an image (`imageUrl`) or a page's files (`files`, SH-14) onto the
     * system sheet. Text and a link both present go as one message, the link on its own line
     * (Chrome's Web Share does the same; a selection's share carries the text and its link to the
     * highlight, SH-11). With `awaitOutcome` the answer waits for the sheet to close and says how
     * it ended – `shared` or `aborted` – for a page's `navigator.share` promise (see [Outcome]);
     * without it the answer comes as soon as the sheet is up.
     */
    fun share(args: JSONObject, reply: (Any?) -> Unit) {
        val title = args.strOrNull("title")?.trim()?.ifEmpty { null }
        val url = args.strOrNull("url")?.trim()?.ifEmpty { null }
        val text = args.strOrNull("text")?.trim()?.ifEmpty { null }
        val imageUrl = args.strOrNull("imageUrl")?.trim()?.ifEmpty { null }
        val tabId = args.strOrNull("tabId")
        val favicon = args.strOrNull("favicon")?.ifEmpty { null }
        val files = args.optJSONArray("files")?.takeIf { it.length() > 0 }
        val awaitOutcome = args.optBoolean("awaitOutcome")
        val body = messageBody(text, url)
        when {
            files != null -> shareFiles(files, title, body, tabId, awaitOutcome, reply)
            imageUrl != null -> shareImage(imageUrl, title, tabId, reply)
            body != null -> shareText(title, body, url, favicon, tabId, awaitOutcome, reply)
            else -> reply(Host.Rejection("nothing to share"))
        }
    }

    /**
     * A link (or plain text). `EXTRA_TITLE` and a `ClipData` thumbnail are what the sharesheet
     * shows as the preview on Android 10+; the favicon is written to the cache so the sheet can
     * read it through the FileProvider.
     */
    private fun shareText(title: String?, body: String, url: String?, favicon: String?, tabId: String?, awaitOutcome: Boolean, reply: (Any?) -> Unit) {
        io.execute {
            val thumbnail = favicon?.let { runCatching { cacheImage(it, "favicon", null) }.getOrNull() }
            main.post {
                val send = Intent(Intent.ACTION_SEND).apply {
                    type = "text/plain"
                    putExtra(Intent.EXTRA_TEXT, body)
                    if (title != null) {
                        putExtra(Intent.EXTRA_SUBJECT, title)
                        putExtra(Intent.EXTRA_TITLE, title)
                    }
                    if (thumbnail != null) {
                        clipData = ClipData.newUri(activity.contentResolver, title ?: "Zenium", thumbnail)
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    }
                }
                launchChooser(send, url, tabId, reply, awaitOutcome)
            }
        }
    }

    /**
     * A page's files (`navigator.share({ files })`): each written to the cache under its own name
     * (`spillFiles`, unless the page-message path did it already and left a `uri`), then one
     * `ACTION_SEND` – or `ACTION_SEND_MULTIPLE` – with the files as streams under their common
     * type, the message (text, link) beside them. A file that cannot be written drops the share.
     */
    private fun shareFiles(files: JSONArray, title: String?, body: String?, tabId: String?, awaitOutcome: Boolean, reply: (Any?) -> Unit) {
        io.execute {
            val spilled = runCatching { spillFiles(files) }.getOrNull()
            main.post {
                if (spilled == null || spilled.length() == 0) {
                    reply(Host.Rejection("the files could not be prepared"))
                    return@post
                }
                val uris = ArrayList<Uri>()
                val types = ArrayList<String>()
                for (i in 0 until spilled.length()) {
                    val file = spilled.getJSONObject(i)
                    uris += Uri.parse(file.str("uri"))
                    types += file.str("type").ifEmpty { activity.contentResolver.getType(uris.last()) ?: "application/octet-stream" }
                }
                val send = Intent(if (uris.size == 1) Intent.ACTION_SEND else Intent.ACTION_SEND_MULTIPLE).apply {
                    type = commonMimeType(types)
                    if (uris.size == 1) putExtra(Intent.EXTRA_STREAM, uris[0]) else putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
                    if (body != null) putExtra(Intent.EXTRA_TEXT, body)
                    if (title != null) {
                        putExtra(Intent.EXTRA_SUBJECT, title)
                        putExtra(Intent.EXTRA_TITLE, title)
                    }
                    val clip = ClipData.newUri(activity.contentResolver, title ?: "Files", uris[0])
                    for (i in 1 until uris.size) clip.addItem(ClipData.Item(uris[i]))
                    clipData = clip
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                launchChooser(send, null, tabId, reply, awaitOutcome)
            }
        }
    }

    /**
     * A page's share message on its way to the core (`TabWebView.onPageMessage`, SH-14): its
     * files' bytes (`data`, base64) written to the cache here, each replaced by the file's
     * `content:` address (`uri`), so the bytes cross into the chrome once, not as a string
     * through the core and back. Off the main thread; `then` on it, with the message as it
     * stands – unchanged when there are no files or the write failed (the core's checks refuse a
     * file left without either, and the page hears `aborted`).
     */
    fun spillPageShare(message: JSONObject, then: (JSONObject) -> Unit) {
        val files = message.optJSONObject("share")?.optJSONArray("files")?.takeIf { it.length() > 0 }
        if (files == null) {
            then(message)
            return
        }
        io.execute {
            val spilled = runCatching { spillFiles(files) }.getOrNull()
            main.post {
                if (spilled != null) message.getJSONObject("share").put("files", spilled)
                then(message)
            }
        }
    }

    /**
     * The files of a share call as files of Zenium's own: `[{ name, type, size, data | uri }]` →
     * the same with `uri` alone, the bytes decoded into `cache/share/<share>/<name>` behind the
     * FileProvider (a folder per share keeps the pages' own names, which the target reads). IO thread.
     */
    fun spillFiles(files: JSONArray): JSONArray {
        val dir = File(File(activity.cacheDir, "share"), "p${System.currentTimeMillis()}-${(Math.random() * 1_000_000).toInt()}").apply { mkdirs() }
        val out = JSONArray()
        val taken = HashSet<String>()
        for (i in 0 until files.length()) {
            val file = files.getJSONObject(i)
            val name = safeFileName(file.strOrNull("name"), file.str("type"), taken)
            val type = file.str("type")
            val uri = file.strOrNull("uri")?.ifEmpty { null } ?: run {
                val data = file.strOrNull("data") ?: throw IllegalStateException("a file without bytes")
                val target = File(dir, name)
                target.writeBytes(Base64.decode(data, Base64.DEFAULT))
                FileProvider.getUriForFile(activity, "${activity.packageName}.files", target).toString()
            }
            out.put(json("name" to name, "type" to type, "size" to file.optLong("size"), "uri" to uri))
        }
        return out
    }

    /** An image as a file: fetched with the tab's cookies (or decoded from a `data:` URL) into the cache. */
    private fun shareImage(imageUrl: String, title: String?, tabId: String?, reply: (Any?) -> Unit) {
        val userAgent = tabId?.let { host.tabs.get(it) }?.settings?.userAgentString
        io.execute {
            val file = runCatching { cacheImage(imageUrl, "image", userAgent) }.getOrNull()
            main.post {
                if (file == null) {
                    reply(Host.Rejection("the image could not be downloaded"))
                    return@post
                }
                val mime = activity.contentResolver.getType(file) ?: "image/*"
                val send = Intent(Intent.ACTION_SEND).apply {
                    type = mime
                    putExtra(Intent.EXTRA_STREAM, file)
                    if (title != null) putExtra(Intent.EXTRA_TITLE, title)
                    clipData = ClipData.newUri(activity.contentResolver, title ?: "Image", file)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                launchChooser(send, null, tabId, reply)
            }
        }
    }

    /**
     * The system sheet for `send`. Zenium's own action row (Android 14) goes with a link of the
     * browser's own (`url`); a page's awaited share gets the plain sheet – a Copy link there would
     * end the page's promise as a dismissal. With `awaitOutcome` the sheet is started for a
     * result and told to report the chosen target ([Outcome]); the reply is `shared` or `aborted`.
     */
    fun launchChooser(send: Intent, url: String?, tabId: String?, reply: (Any?) -> Unit, awaitOutcome: Boolean = false) {
        val outcome = if (awaitOutcome) Outcome(reply) else null
        val chooser = if (outcome != null) Intent.createChooser(send, null, outcome.sender()) else Intent.createChooser(send, null)
        // Zenium is a share target itself; sharing from it to it is never what the tap meant.
        chooser.putExtra(Intent.EXTRA_EXCLUDE_COMPONENTS, arrayOf(ComponentName(activity, MainActivity::class.java)))
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE && url != null && outcome == null) {
            chooser.putExtra(Intent.EXTRA_CHOOSER_CUSTOM_ACTIONS, browserActions(url, tabId).toTypedArray())
        }
        try {
            if (outcome != null) {
                pending?.settle(SHARE_ABORTED)
                pending = outcome
                outcome.register()
                if (!activity.launchChooserForResult(chooser, outcome::onReturned)) throw IllegalStateException("the share sheet could not be opened")
            } else {
                activity.startActivity(chooser)
                reply(null)
            }
        } catch (e: Exception) {
            pending?.takeIf { it === outcome }?.let { pending = null }
            outcome?.unregister()
            reply(Host.Rejection(e.message ?: "the share sheet could not be opened"))
        }
    }

    /** The one awaited share on the sheet (a second call supersedes it: its page hears `aborted`). */
    private var pending: Outcome? = null

    /**
     * How an awaited share ends. The chooser reports a chosen target through the `IntentSender`
     * it was given (a broadcast back into this process; immutable – the chosen component is not
     * needed, that it fired is) and finishes either way, so the activity's result alone cannot
     * tell a share from a dismissal. The two arrive in no fixed order: a report settles `shared`
     * once the sheet has returned, a return waits [CHOSEN_GRACE_MS] for a report before settling
     * `aborted`. Settled once; the receiver goes with it.
     */
    private inner class Outcome(private val reply: (Any?) -> Unit) {
        private var chosen = false
        private var returned = false
        private var settled = false
        private val grace = Runnable { settle(if (chosen) SHARE_SHARED else SHARE_ABORTED) }
        private val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                chosen = true
                if (returned) settle(SHARE_SHARED)
            }
        }

        fun sender(): IntentSender {
            val intent = Intent(ACTION_CHOSEN).setPackage(activity.packageName)
            return PendingIntent.getBroadcast(activity, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE).intentSender
        }

        fun register() {
            ContextCompat.registerReceiver(activity, receiver, IntentFilter(ACTION_CHOSEN), ContextCompat.RECEIVER_NOT_EXPORTED)
        }

        fun unregister() {
            runCatching { activity.unregisterReceiver(receiver) }
        }

        /** The chooser activity finished (a target taken, or the sheet dismissed). */
        fun onReturned() {
            returned = true
            if (chosen) settle(SHARE_SHARED) else main.postDelayed(grace, CHOSEN_GRACE_MS)
        }

        fun settle(result: String) {
            if (settled) return
            settled = true
            main.removeCallbacks(grace)
            unregister()
            if (pending === this) pending = null
            reply(result)
        }
    }


    /**
     * Android 14's row of the sharing app's own actions. Each is a `PendingIntent` back into
     * `MainActivity` (single task, so it arrives as a new intent) naming the action and the link.
     */
    @RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
    private fun browserActions(url: String, tabId: String?): List<ChooserAction> {
        fun action(kind: String, label: String, icon: Int): ChooserAction {
            val intent = Intent(activity, MainActivity::class.java)
                .setAction(ACTION_BROWSER_ACTION)
                .putExtra(EXTRA_KIND, kind)
                .putExtra(EXTRA_URL, url)
                .putExtra(EXTRA_TAB_ID, tabId)
            // One request code per action keeps the four apart; the URL is updated in place.
            val pending = PendingIntent.getActivity(
                activity, kind.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            return ChooserAction.Builder(Icon.createWithResource(activity, icon), label, pending).build()
        }
        val actions = mutableListOf(
            action(KIND_COPY, "Copy link", R.drawable.ic_share_copy),
            action(KIND_QR, "QR code", R.drawable.ic_share_qr)
        )
        if (tabId != null) {
            actions += action(KIND_SCREENSHOT, "Screenshot", R.drawable.ic_share_screenshot)
            actions += action(KIND_PRINT, "Print", R.drawable.ic_share_print)
        }
        return actions
    }

    /** One of the action row's buttons was tapped (the sheet has closed and Zenium is back). */
    fun onBrowserAction(intent: Intent) {
        val kind = intent.getStringExtra(EXTRA_KIND) ?: return
        val url = intent.getStringExtra(EXTRA_URL) ?: return
        val tabId = intent.getStringExtra(EXTRA_TAB_ID)
        if (kind == KIND_QR) {
            showQrCode(url)
            return
        }
        val event = json("kind" to kind, "url" to url, "tabId" to tabId)
        // A screenshot wants the page back on screen first: the sheet is still on its way out.
        if (kind == KIND_SCREENSHOT) main.postDelayed({ host.chrome.hostEvent("share.action", event) }, SCREENSHOT_DELAY_MS)
        else host.chrome.hostEvent("share.action", event)
    }

    // --- in: Zenium as a share target ------------------------------------------------------------

    /** Another app shared into Zenium (`ACTION_SEND`): text, a link in text, or an image. */
    fun onReceived(intent: Intent) {
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)
        val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)
        val type = intent.type
        val stream = if (type?.startsWith("image/") == true) IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java) else null
        val describe = { imageDataUrl: String? ->
            host.chrome.hostEvent(
                "intent",
                json("kind" to "send", "text" to text, "subject" to subject, "mimeType" to type, "imageDataUrl" to imageDataUrl)
            )
        }
        if (stream == null) {
            describe(null)
            return
        }
        io.execute {
            val dataUrl = runCatching { readSharedImage(stream, type!!) }.getOrNull()
            main.post { describe(dataUrl) }
        }
    }

    /** `ACTION_WEB_SEARCH`: the query runs with the user's engine. */
    fun onWebSearch(intent: Intent) {
        val query = intent.getStringExtra(SearchManager.QUERY) ?: return
        host.chrome.hostEvent("intent", json("kind" to "search", "text" to query))
    }

    /**
     * The shared image as a `data:` URL the core can show in a tab. Decoded through a sample size
     * that keeps the longer side within `MAX_IMAGE_SIDE`, so a 50-megapixel photo does not become
     * a hundred-megabyte string; PNG stays PNG (transparency), a small GIF stays itself (animation).
     */
    private fun readSharedImage(uri: Uri, type: String): String? {
        val resolver = activity.contentResolver
        val bytes = resolver.openInputStream(uri)?.use { input -> readAtMost(input.readBytes(), MAX_IMAGE_BYTES) } ?: return null
        val mime = resolver.getType(uri) ?: type
        if (mime == "image/gif" && bytes.size <= MAX_GIF_BYTES) return dataUrl(mime, bytes)
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / sample > MAX_IMAGE_SIDE) sample *= 2
        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
            ?: return null
        val out = ByteArrayOutputStream()
        val png = mime == "image/png" || bitmap.hasAlpha()
        bitmap.compress(if (png) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG, 88, out)
        bitmap.recycle()
        return dataUrl(if (png) "image/png" else "image/jpeg", out.toByteArray())
    }

    private fun readAtMost(bytes: ByteArray, limit: Int): ByteArray? = if (bytes.size > limit) null else bytes

    private fun dataUrl(mime: String, bytes: ByteArray): String =
        "data:$mime;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)

    // --- QR code (the action row) -------------------------------------------------------------------

    /** The link as a QR code in a dialog, with a button to keep it as a picture. */
    private fun showQrCode(url: String) {
        io.execute {
            val bitmap = runCatching { qrBitmap(url, QR_SIZE_PX) }.getOrNull()
            main.post {
                if (bitmap == null) {
                    Toast.makeText(activity, "This link is too long for a QR code", Toast.LENGTH_SHORT).show()
                    return@post
                }
                val pad = (24 * activity.resources.displayMetrics.density).toInt()
                val image = ImageView(activity).apply {
                    setImageBitmap(bitmap)
                    adjustViewBounds = true
                    setPadding(pad, pad, pad, 0)
                }
                MaterialAlertDialogBuilder(activity)
                    .setTitle("Scan to open")
                    .setMessage(url)
                    .setView(image)
                    .setPositiveButton("Save") { _, _ -> saveQrCode(url, bitmap) }
                    .setNegativeButton("Close", null)
                    .show()
            }
        }
    }

    private fun saveQrCode(url: String, bitmap: Bitmap) {
        io.execute {
            val out = ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
            val name = "zenium-qr-" + (Uri.parse(url).host ?: "link").replace(Regex("[^A-Za-z0-9.-]"), "_") + ".png"
            main.post {
                host.saveToDownloads(name, "image/png", out.toByteArray()) { result ->
                    Toast.makeText(activity, if (result != null) "Saved to Downloads" else "Could not save the QR code", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    // --- cache files behind the FileProvider ----------------------------------------------------

    /**
     * Fetch (or decode) an image into `cache/share/` and return its content URI. HTTP fetches carry
     * the cookies the tab has for the address, so an image behind a login comes through as the
     * page showed it. Files older than a day are cleared on the way.
     */
    private fun cacheImage(source: String, prefix: String, userAgent: String?): Uri {
        val dir = File(activity.cacheDir, "share").apply { mkdirs() }
        val cutoff = System.currentTimeMillis() - CACHE_TTL_MS
        dir.listFiles()?.forEach { if (it.lastModified() < cutoff) it.delete() }
        val (bytes, declaredMime) = if (source.startsWith("data:")) {
            val comma = source.indexOf(',')
            val header = source.substring(5, maxOf(5, comma))
            val mime = header.substringBefore(';').ifEmpty { null }
            val payload = source.substring(comma + 1)
            val decoded = if (header.contains(";base64")) Base64.decode(payload, Base64.DEFAULT) else Uri.decode(payload).toByteArray()
            decoded to mime
        } else {
            val conn = (URL(source).openConnection() as HttpURLConnection).apply {
                connectTimeout = FETCH_TIMEOUT_MS
                readTimeout = FETCH_TIMEOUT_MS
                instanceFollowRedirects = true
                CookieManager.getInstance().getCookie(source)?.let { setRequestProperty("Cookie", it) }
                userAgent?.let { setRequestProperty("User-Agent", it) }
                setRequestProperty("Accept", "image/*,*/*;q=0.8")
            }
            if (conn.responseCode !in 200..299) throw IllegalStateException("HTTP ${conn.responseCode}")
            val data = conn.inputStream.use { it.readBytes() }
            data to conn.contentType?.substringBefore(';')?.trim()
        }
        if (bytes.isEmpty()) throw IllegalStateException("empty image")
        val mime = sniffImageMime(bytes) ?: declaredMime?.takeIf { it.startsWith("image/") } ?: "image/png"
        val file = File(dir, "$prefix-${System.currentTimeMillis()}.${extensionFor(mime)}")
        file.writeBytes(bytes)
        return FileProvider.getUriForFile(activity, "${activity.packageName}.files", file)
    }

    companion object {
        /** The action row's `PendingIntent`s come back to `MainActivity` under this action. */
        const val ACTION_BROWSER_ACTION = "app.zen.chromium.SHARE_ACTION"
        const val EXTRA_KIND = "kind"
        const val EXTRA_URL = "url"
        const val EXTRA_TAB_ID = "tabId"
        const val KIND_COPY = "copy"
        const val KIND_QR = "qr"
        const val KIND_SCREENSHOT = "screenshot"
        const val KIND_PRINT = "print"

        /** The chooser's report of a chosen target comes back under this action ([Outcome]). */
        const val ACTION_CHOSEN = "app.zen.chromium.SHARE_CHOSEN"
        /** An awaited share's answers, as the core reads them (`ShareOutcome`). */
        const val SHARE_SHARED = "shared"
        const val SHARE_ABORTED = "aborted"
        /** How long a returned sheet waits for the chosen-target report before it counts as dismissed. */
        const val CHOSEN_GRACE_MS = 800L
        /** A shared file's name is cut to this many characters (the extension kept). */
        const val FILE_NAME_MAX = 120

        private const val SCREENSHOT_DELAY_MS = 450L
        private const val FETCH_TIMEOUT_MS = 10_000

        /** The sheet's type for a set of files: their one type, `image/*` for pictures of several kinds, else anything. */
        fun commonMimeType(types: List<String>): String {
            val distinct = types.map { it.ifEmpty { "application/octet-stream" } }.distinct()
            if (distinct.size == 1) return distinct[0]
            val groups = distinct.map { it.substringBefore('/') }.distinct()
            return if (groups.size == 1) "${groups[0]}/*" else "*/*"
        }

        /**
         * The one message a share carries for its text and link: the text, then the link on a line
         * of its own (Chrome's `navigator.share` composition; a selection's share reads as the
         * quote and its link to the highlight), either alone when the other is missing, null when both are.
         */
        fun messageBody(text: String?, url: String?): String? = when {
            text != null && url != null -> if (text == url) url else "$text\n$url"
            else -> text ?: url
        }

        /**
         * A page's file name made safe for the cache: path separators and control characters out,
         * an empty or dotted name replaced by one from its type, cut to [FILE_NAME_MAX] with the
         * extension kept, and unique among `taken` (a numbered copy otherwise).
         */
        fun safeFileName(name: String?, type: String, taken: MutableSet<String>): String {
            var base = (name ?: "").replace(Regex("[\\\\/\\p{Cntrl}]"), "_").trim().trimStart('.')
            if (base.isEmpty()) base = "file.${extensionFor(type)}"
            val dot = base.lastIndexOf('.')
            var stem = if (dot > 0) base.substring(0, dot) else base
            val ext = if (dot > 0) base.substring(dot) else ""
            if (stem.length + ext.length > FILE_NAME_MAX) stem = stem.take(maxOf(1, FILE_NAME_MAX - ext.length))
            var candidate = stem + ext
            var n = 2
            while (!taken.add(candidate)) candidate = "$stem (${n++})$ext"
            return candidate
        }
        private const val CACHE_TTL_MS = 24 * 60 * 60 * 1000L
        private const val QR_SIZE_PX = 720
        /** A shared image larger than this is not read at all (the text that came with it still is). */
        private const val MAX_IMAGE_BYTES = 40 * 1024 * 1024
        private const val MAX_GIF_BYTES = 4 * 1024 * 1024
        private const val MAX_IMAGE_SIDE = 2048

        /** The link as a QR code (error correction M, a two-module quiet zone), black on white. */
        fun qrBitmap(text: String, size: Int): Bitmap {
            val hints = mapOf(EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M, EncodeHintType.MARGIN to 2)
            val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size, hints)
            val pixels = IntArray(matrix.width * matrix.height)
            for (y in 0 until matrix.height) for (x in 0 until matrix.width) {
                pixels[y * matrix.width + x] = if (matrix.get(x, y)) Color.BLACK else Color.WHITE
            }
            return Bitmap.createBitmap(pixels, matrix.width, matrix.height, Bitmap.Config.RGB_565)
        }

        /** The image type from the bytes' signature; servers and `data:` URLs get it wrong often enough. */
        fun sniffImageMime(bytes: ByteArray): String? {
            fun startsWith(vararg signature: Int): Boolean =
                bytes.size >= signature.size && signature.indices.all { bytes[it].toInt() and 0xff == signature[it] }
            return when {
                startsWith(0x89, 0x50, 0x4e, 0x47) -> "image/png"
                startsWith(0xff, 0xd8, 0xff) -> "image/jpeg"
                startsWith(0x47, 0x49, 0x46, 0x38) -> "image/gif"
                startsWith(0x52, 0x49, 0x46, 0x46) && bytes.size >= 12 &&
                    bytes[8].toInt() == 0x57 && bytes[9].toInt() == 0x45 && bytes[10].toInt() == 0x42 && bytes[11].toInt() == 0x50 -> "image/webp"
                startsWith(0x42, 0x4d) -> "image/bmp"
                bytes.size >= 12 && bytes[4].toInt() == 0x66 && bytes[5].toInt() == 0x74 && bytes[6].toInt() == 0x79 && bytes[7].toInt() == 0x70 -> "image/avif"
                bytes.take(256).toByteArray().toString(Charsets.US_ASCII).contains("<svg") -> "image/svg+xml"
                else -> null
            }
        }

        fun extensionFor(mime: String): String = when (mime) {
            "image/jpeg" -> "jpg"
            "image/gif" -> "gif"
            "image/webp" -> "webp"
            "image/bmp" -> "bmp"
            "image/avif" -> "avif"
            "image/svg+xml" -> "svg"
            else -> "png"
        }
    }
}
