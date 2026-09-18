package app.zen.chromium

import android.Manifest
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.ContentUris
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.MediaStore
import android.webkit.CookieManager
import android.webkit.WebSettings
import android.widget.Toast
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import org.json.JSONObject
import org.json.JSONTokener
import java.io.File
import java.io.IOException
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.Base64
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * The Zenium downloader for Android. The tab WebView reports a download (`DownloadListener`, or
 * "Save link / image" through `view.download`); this class announces it to the core, waits for
 * the core to bind a record and say where it goes (the default location, a folder the user chose
 * in Settings, or "ask" – a system save dialog), then transfers the bytes itself on an I/O
 * thread with `HttpURLConnection`, appending to the partial file with `Range` / `If-Range` after
 * a pause, a network failure or an app restart. `data:` URLs are decoded in place; `blob:` URLs
 * are read from the page in base64 chunks through the tab's script bridge. Progress goes to the
 * core (which keeps the list and drives the panel) and to a system notification; a transfer from
 * the private container gets a notification that names neither the file nor the site.
 *
 * `DownloadManager` is kept for two things it does better: listing pre-Android 10 files in the
 * system Downloads app (`addCompletedDownload`, in `DownloadSink`) and opening that app
 * (`ACTION_VIEW_DOWNLOADS`). It cannot pause or resume on request, so the transfers left it.
 *
 * Transfers run in the app process (no service is declared in the manifest); a
 * `DownloadForegroundService` wrapping this class is the path to keep long transfers alive in
 * the background once the manifest gains the entry.
 */
class Downloads(private val activity: BrowserActivity, private val host: PageHost) {
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newCachedThreadPool { r -> Thread(r, "zenium-download").apply { isDaemon = true } }
    private val notifications = DownloadNotifications(activity) { id, op -> emit("download.action", json("id" to id, "op" to op)) }
    private val live = HashMap<String, Live>() // token → transfer
    private val byCoreId = HashMap<String, Live>()
    private var seq = 0
    private var askedNotifications = false

    enum class Kind { HTTP, DATA, BLOB }
    enum class Control { RUN, PAUSE, CANCEL }

    sealed class Destination {
        object Default : Destination()
        class Folder(val tree: Uri) : Destination()
        class Document(val uri: Uri) : Destination()
    }

    class Live(val token: String, val kind: Kind, val url: String, val userAgent: String, val sourceTabId: String?) {
        var coreId: String? = null
        /** Record this transfer continues (a retry); the core keeps the row instead of adding one. */
        var resumes: String? = null
        var referrer = ""
        /** Name the server, the page or the URL suggested. */
        var filename = "download"
        /** Name the file is written under once a sink exists (MediaStore or the folder may have made it unique). */
        var finalName = ""
        var mimeType = ""
        /** Container (WebView profile) of the page; the private profile keeps the item out of downloads.json. */
        var containerId = Profiles.DEFAULT_CONTAINER
        var isPrivate = false
        var total = -1L
        var received = 0L
        var etag = ""
        var lastModified = ""
        var canResume = false
        var data: ByteArray? = null
        var sink: DownloadSink? = null
        var destination: Destination = Destination.Default
        var bound = false
        @Volatile var control = Control.RUN
        @Volatile var running = false
        var lastReport = 0L
        /** Network failures retried on our own since the last byte arrived. */
        @Volatile var autoResumes = 0
    }

    private class Cancelled : Exception()

    // ---------------------------------------------------------------------------------------------
    // From the WebView and the core
    // ---------------------------------------------------------------------------------------------

    /**
     * A page started a download (or the user saved a link); announce it and wait for the core to
     * bind it. The container comes from the tab when there is one (its WebView profile), else from
     * the record being retried; the private container marks the item private.
     */
    fun start(
        url: String,
        userAgent: String,
        contentDisposition: String?,
        mimeType: String?,
        contentLength: Long,
        sourceTabId: String?,
        referrer: String? = null,
        containerId: String? = null,
        resumes: String? = null
    ) {
        val kind = when {
            url.startsWith("blob:") -> Kind.BLOB
            url.startsWith("data:") -> Kind.DATA
            url.startsWith("http://") || url.startsWith("https://") -> Kind.HTTP
            else -> {
                toast("Zenium cannot download this kind of link")
                return
            }
        }
        val tab = sourceTabId?.let { host.tabs.get(it) }
        if (kind == Kind.BLOB && tab == null) {
            toast("The page that made this file is gone")
            return
        }
        val l = Live("dl-${++seq}-${SystemClock.elapsedRealtime()}", kind, url, userAgent.ifEmpty { defaultUserAgent() }, sourceTabId)
        l.resumes = resumes
        l.containerId = tab?.containerId ?: containerId?.ifEmpty { null } ?: Profiles.DEFAULT_CONTAINER
        l.isPrivate = l.containerId == PRIVATE_CONTAINER
        l.referrer = referrer ?: tab?.url?.takeIf { it.startsWith("http") } ?: ""
        var mime = mimeType?.let(DownloadLogic::mimeBase) ?: ""
        if (kind == Kind.DATA) {
            val parsed = DownloadLogic.parseDataUrl(url)
            if (parsed == null) {
                toast("This data: link is malformed")
                return
            }
            l.data = parsed.bytes
            l.total = parsed.bytes.size.toLong()
            if (mime.isEmpty() || mime == "application/octet-stream") mime = parsed.mimeType
        } else if (contentLength > 0) {
            l.total = contentLength
        }
        l.mimeType = mime
        val serverName = DownloadLogic.dispositionFilename(contentDisposition)
        if (tab != null && serverName.isNullOrEmpty() && (kind != Kind.HTTP || DownloadLogic.sameOrigin(url, l.referrer))) {
            // The anchor's `download` attribute is the only name a blob: or data: URL has; the
            // page script keeps it for us (src/android/pageScript.ts). Like Blink, it counts for
            // http(s) links only on the page's own origin.
            val key = JSONObject.quote(DownloadLogic.downloadNameKey(url))
            tab.evaluate("(function(){var r=window.__zeniumDownloadNames;return (r&&r[$key])||null})()") { result ->
                val suggested = result?.takeIf { it.startsWith("\"") }?.let { runCatching { JSONTokener(it).nextValue() as? String }.getOrNull() }
                announce(l, contentDisposition, suggested)
            }
        } else {
            announce(l, contentDisposition, null)
        }
    }

    private fun announce(l: Live, contentDisposition: String?, suggestedName: String?) {
        l.filename = DownloadLogic.filenameFor(l.url, contentDisposition, l.mimeType.ifEmpty { null }, DownloadSink::extensionFor, suggestedName)
        live[l.token] = l
        emit(
            "download.started",
            json(
                "token" to l.token, "url" to l.url, "referrer" to l.referrer, "filename" to l.filename,
                "totalBytes" to l.total.coerceAtLeast(0), "mimeType" to l.mimeType, "sourceTabId" to l.sourceTabId,
                "containerId" to l.containerId, "resumes" to l.resumes
            )
        )
    }

    /**
     * The core made a record for the announced transfer and says where the file goes. `private`
     * is the core's verdict on the record (it follows from the container); the notification for a
     * private transfer names neither the file nor the site.
     */
    fun bind(token: String, coreId: String, destination: JSONObject, private: Boolean) {
        val l = live[token] ?: return
        l.coreId = coreId
        l.isPrivate = l.isPrivate || private
        byCoreId[coreId] = l
        if (l.bound) return
        l.bound = true
        if (l.sink != null) {
            launch(l)
            return
        }
        when (destination.str("mode")) {
            "ask" -> activity.createDocument(l.filename, l.mimeType.ifEmpty { DownloadSink.mimeFor(l.filename) }) { uri ->
                if (uri == null) {
                    // Like Chrome: dismissing the save dialog means no download at all.
                    done(l, "cancelled", error = "dismissed")
                    return@createDocument
                }
                l.destination = Destination.Document(uri)
                launch(l)
            }
            "folder" -> {
                val tree = destination.strOrNull("folder")?.let { runCatching { Uri.parse(it) }.getOrNull() }
                l.destination = if (tree != null) Destination.Folder(tree) else Destination.Default
                launch(l)
            }
            else -> launch(l)
        }
    }

    fun pause(coreId: String) {
        val l = byCoreId[coreId] ?: return
        if (l.kind != Kind.HTTP) return
        l.control = Control.PAUSE
        // Not running: waiting out the back-off before an automatic retry; hold there.
        if (!l.running && l.sink != null) paused(l)
    }

    /**
     * Continue a paused transfer, or one interrupted earlier – including before a restart, when
     * only the core's record is left: the partial file is reopened from `savePath` and the rest
     * is requested with `Range`.
     */
    fun resume(args: JSONObject) {
        val id = args.str("id")
        val known = byCoreId[id]
        if (known != null) {
            if (known.running) known.control = Control.RUN
            else launch(known)
            return
        }
        val url = args.str("url")
        val savePath = args.str("savePath")
        val filename = args.str("filename")
        val onDisk = args.str("finalName").ifEmpty { filename }
        val sink = if (url.startsWith("http")) DownloadSink.reopen(activity, savePath, onDisk) else null
        if (sink == null) {
            retry(args)
            return
        }
        val l = Live("dl-${++seq}-${SystemClock.elapsedRealtime()}", Kind.HTTP, url, defaultUserAgent(), null)
        l.coreId = id
        l.referrer = args.str("referrer")
        l.filename = filename.ifEmpty { sink.displayName }
        l.finalName = sink.displayName.removeSuffix(DownloadLogic.PARTIAL_SUFFIX)
        l.mimeType = args.str("mimeType")
        l.total = args.num("totalBytes").toLong().takeIf { it > 0 } ?: -1L
        l.etag = args.str("etag")
        l.lastModified = args.str("lastModified")
        l.containerId = args.str("containerId").ifEmpty { Profiles.DEFAULT_CONTAINER }
        l.isPrivate = args.bool("private") || l.containerId == PRIVATE_CONTAINER
        l.canResume = true
        l.sink = sink
        l.bound = true
        live[l.token] = l
        byCoreId[id] = l
        emit(
            "download.started",
            json(
                "token" to l.token, "url" to url, "referrer" to l.referrer, "filename" to l.filename,
                "totalBytes" to l.total.coerceAtLeast(0), "mimeType" to l.mimeType, "sourceTabId" to null,
                "containerId" to l.containerId, "resumes" to id, "savePath" to savePath, "canResume" to true
            )
        )
        launch(l)
    }

    fun cancel(coreId: String) {
        val l = byCoreId[coreId] ?: return
        if (l.running) l.control = Control.CANCEL
        else {
            l.sink?.delete()
            done(l, "cancelled")
        }
    }

    /**
     * Start over: a fresh transfer of the same URL with the same referrer that reports back into
     * the same record (`resumes`), so the row keeps its place in the list.
     */
    fun retry(args: JSONObject) {
        val url = args.str("url")
        if (!url.startsWith("http") && !url.startsWith("data:")) return
        val name = args.str("filename")
        start(
            url, defaultUserAgent(),
            if (name.isNotEmpty()) "attachment; filename=\"${name.replace("\"", "")}\"" else null,
            args.str("mimeType").ifEmpty { null }, -1, null, args.str("referrer"),
            containerId = args.str("containerId"), resumes = args.strOrNull("id")
        )
    }

    /**
     * Publish a finished file under its final name (quarantined files wait here for Keep) and,
     * when the setting asks for it, announce it with the "Download complete" notification.
     */
    fun release(args: JSONObject, reply: (Any?) -> Unit) {
        val savePath = args.str("savePath")
        val onDisk = args.str("finalName").ifEmpty { args.str("filename") }
        val private = args.bool("private")
        io.execute {
            val result = runCatching {
                val sink = DownloadSink.reopen(activity, savePath, onDisk) ?: return@runCatching null
                val (path, name) = sink.finish(args.str("mimeType"), args.str("url"), args.str("referrer"))
                Triple(path, name, sink)
            }.getOrNull()
            main.post {
                if (result == null) {
                    reply(null)
                    return@post
                }
                val (path, name, _) = result
                if (args.bool("notify")) {
                    notifications.completed(args.str("id"), name, args.str("mimeType"), shareUri(path), private)
                }
                reply(json("savePath" to path, "finalName" to name))
            }
        }
    }

    fun discard(args: JSONObject, reply: (Any?) -> Unit) {
        val savePath = args.str("savePath")
        val onDisk = args.str("finalName").ifEmpty { args.str("filename") }
        io.execute {
            runCatching { DownloadSink.reopen(activity, savePath, onDisk)?.delete() }
            main.post { reply(null) }
        }
    }

    fun open(savePath: String, mimeType: String) {
        val uri = shareUri(savePath) ?: return
        val type = mimeType.ifEmpty { activity.contentResolver.getType(uri) ?: DownloadSink.mimeFor(savePath) }
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, type)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
            activity.startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            toast("No app can open this file")
        }
    }

    fun showAll() {
        runCatching {
            activity.startActivity(Intent(DownloadManager.ACTION_VIEW_DOWNLOADS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }

    /** Settings › Downloads: a folder for future downloads, kept as a persistable tree URI. */
    fun chooseDirectory(reply: (Any?) -> Unit) {
        activity.pickFolder { uri ->
            if (uri != null) {
                runCatching {
                    activity.contentResolver.takePersistableUriPermission(
                        uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                    )
                }
            }
            reply(uri?.toString())
        }
    }

    fun destroy() {
        for (l in live.values) l.control = Control.CANCEL
        notifications.destroy()
        io.shutdownNow()
    }

    // ---------------------------------------------------------------------------------------------
    // Transfers
    // ---------------------------------------------------------------------------------------------

    private fun launch(l: Live) {
        ensurePermissions(l) {
            // Cancelled or finished while a dialog or permission prompt was up.
            if (l.running || live[l.token] !== l) return@ensurePermissions
            l.running = true
            l.control = Control.RUN
            io.execute { transfer(l) }
        }
    }

    private fun ensurePermissions(l: Live, then: () -> Unit) {
        val needed = ArrayList<String>()
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q && l.destination is Destination.Default && l.sink == null &&
            !granted(Manifest.permission.WRITE_EXTERNAL_STORAGE)
        ) needed += Manifest.permission.WRITE_EXTERNAL_STORAGE
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !askedNotifications && !granted(Manifest.permission.POST_NOTIFICATIONS)) {
            askedNotifications = true
            needed += Manifest.permission.POST_NOTIFICATIONS
        }
        if (needed.isEmpty()) then() else activity.requestRuntimePermissions(needed) { then() }
    }

    private fun granted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(activity, permission) == PackageManager.PERMISSION_GRANTED

    private fun transfer(l: Live) {
        var pausedExit = false
        try {
            when (l.kind) {
                Kind.HTTP -> pausedExit = transferHttp(l)
                Kind.DATA -> transferData(l)
                Kind.BLOB -> transferBlob(l)
            }
        } catch (e: Cancelled) {
            l.sink?.delete()
            main.post { done(l, "cancelled") }
        } catch (e: Exception) {
            fail(l, DownloadLogic.failureReason(e), resumable = l.kind == Kind.HTTP && l.canResume && l.sink != null)
        } finally {
            l.running = false
            // Resume pressed while the loop was still winding down after Pause: pick up again.
            if (pausedExit && l.control == Control.RUN) main.post { launch(l) }
        }
    }

    /**
     * A transfer stopped short. Network failures on a resumable transfer are retried on our own
     * a few times with a growing pause (Chromium's `kMaxAutoResumeAttempts`), so a flaky
     * connection never reaches the user; anything else, or the sixth failure in a row, is reported
     * as interrupted.
     */
    private fun fail(l: Live, reason: String, resumable: Boolean) {
        val canRetry = resumable && l.kind == Kind.HTTP && l.canResume && l.sink != null
        if (!DownloadLogic.shouldAutoResume(reason, canRetry, l.autoResumes, userStopped = l.control != Control.RUN)) {
            main.post { interrupted(l, reason, resumable) }
            return
        }
        l.autoResumes++
        main.postDelayed({
            if (live[l.token] === l && l.control == Control.RUN && !l.running) launch(l)
        }, DownloadLogic.autoResumeDelayMs(l.autoResumes))
    }

    /** Returns true when the transfer stopped because it was paused. */
    private fun transferHttp(l: Live): Boolean {
        var offset = l.sink?.size()?.coerceAtLeast(0L) ?: 0L
        val connection = connect(l, offset)
        try {
            val status = connection.responseCode
            val decision = DownloadLogic.continuation(status, connection.getHeaderField("Content-Range"), offset, l.total)
            var append = false
            when (decision) {
                is DownloadLogic.Continuation.Fail -> {
                    fail(l, decision.reason, resumable = offset > 0 && l.canResume && l.sink != null)
                    return false
                }
                DownloadLogic.Continuation.AlreadyComplete -> {
                    l.received = offset
                    main.post { completed(l) }
                    return false
                }
                DownloadLogic.Continuation.Restart -> offset = 0
                DownloadLogic.Continuation.Append -> append = true
            }
            if (!append) readHeaders(l, connection, status)
            else {
                val range = DownloadLogic.parseContentRange(connection.getHeaderField("Content-Range"))
                if (range != null && range.total > 0) l.total = range.total
            }
            if (l.sink == null) l.sink = createSink(l)
            val sink = l.sink!!
            l.received = offset
            report(l, "progressing", force = true)
            val exit = copy(l, connection.inputStream, sink.open(append))
            when (exit) {
                Control.PAUSE -> {
                    main.post { paused(l) }
                    return true
                }
                Control.CANCEL -> throw Cancelled()
                Control.RUN -> {}
            }
            if (l.total > 0 && l.received < l.total) {
                fail(l, "network-failed", resumable = l.canResume)
                return false
            }
            main.post { completed(l) }
            return false
        } finally {
            connection.disconnect()
        }
    }

    private fun connect(l: Live, offset: Long): HttpURLConnection {
        val connection = (URL(l.url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 20_000
            readTimeout = 30_000
            instanceFollowRedirects = true
            setRequestProperty("User-Agent", l.userAgent)
            setRequestProperty("Accept", "*/*")
            // Byte counts must line up with Range offsets: no transparent gzip.
            setRequestProperty("Accept-Encoding", "identity")
            if (l.referrer.isNotEmpty()) setRequestProperty("Referer", l.referrer)
            CookieManager.getInstance().getCookie(l.url)?.let { setRequestProperty("Cookie", it) }
            if (offset > 0) {
                setRequestProperty("Range", "bytes=$offset-")
                DownloadLogic.strongValidator(l.etag, l.lastModified)?.let { setRequestProperty("If-Range", it) }
            }
        }
        return connection
    }

    /** A fresh (non-range) response decides the name, type, size and whether it can resume. */
    private fun readHeaders(l: Live, connection: HttpURLConnection, status: Int) {
        val contentType = connection.getHeaderField("Content-Type")?.let(DownloadLogic::mimeBase)
        if (!contentType.isNullOrEmpty() && contentType != "application/octet-stream" &&
            (l.mimeType.isEmpty() || l.mimeType == "application/octet-stream")
        ) l.mimeType = contentType
        if (l.sink == null) {
            val fromHeader = DownloadLogic.dispositionFilename(connection.getHeaderField("Content-Disposition"))
            if (!fromHeader.isNullOrEmpty()) {
                l.filename = DownloadLogic.filenameFor(l.url, connection.getHeaderField("Content-Disposition"), l.mimeType.ifEmpty { null }, DownloadSink::extensionFor)
            } else if (!l.filename.contains('.') && l.mimeType.isNotEmpty()) {
                l.filename = DownloadLogic.filenameFor(l.url, null, l.mimeType, DownloadSink::extensionFor)
            }
        }
        val length = if (status == 206) DownloadLogic.parseContentRange(connection.getHeaderField("Content-Range"))?.total ?: -1L
        else connection.contentLengthLong
        if (length > 0) l.total = length
        l.etag = connection.getHeaderField("ETag") ?: ""
        l.lastModified = connection.getHeaderField("Last-Modified") ?: ""
        l.canResume = DownloadLogic.canResume(connection.getHeaderField("Accept-Ranges"), l.etag, l.lastModified)
    }

    /** Pump bytes until the end, a pause or a cancel; returns why it stopped. */
    private fun copy(l: Live, input: java.io.InputStream, output: OutputStream): Control {
        input.use { source ->
            output.use { out ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val control = l.control
                    if (control != Control.RUN) {
                        out.flush()
                        return control
                    }
                    val n = source.read(buffer)
                    if (n < 0) break
                    out.write(buffer, 0, n)
                    l.received += n
                    if (l.autoResumes != 0) l.autoResumes = 0
                    report(l, "progressing")
                }
                out.flush()
            }
        }
        return Control.RUN
    }

    private fun transferData(l: Live) {
        val bytes = l.data ?: throw IOException("the data: link is empty")
        if (l.sink == null) l.sink = createSink(l)
        l.total = bytes.size.toLong()
        l.received = 0
        report(l, "progressing", force = true)
        l.sink!!.open(false).use { out ->
            var offset = 0
            while (offset < bytes.size) {
                if (l.control == Control.CANCEL) throw Cancelled()
                val n = minOf(256 * 1024, bytes.size - offset)
                out.write(bytes, offset, n)
                offset += n
                l.received = offset.toLong()
                report(l, "progressing")
            }
        }
        l.data = null
        main.post { completed(l) }
    }

    /**
     * A `blob:` URL only means something inside the page that made it, so the page reads it:
     * `fetch` the blob once and keep it, then hand it over in base64 slices small enough for the
     * script bridge.
     */
    private fun transferBlob(l: Live) {
        val key = JSONObject.quote(l.token)
        val info = evalInPage(
            l,
            "(async()=>{const r=await fetch(${JSONObject.quote(l.url)});const b=await r.blob();" +
                "(window.__zeniumBlobs=window.__zeniumBlobs||{})[$key]=b;return {size:b.size,type:b.type}})()"
        ) as? JSONObject ?: throw IOException("the page could not read the file")
        try {
            l.total = info.optLong("size", -1L)
            val type = info.str("type")
            if (l.mimeType.isEmpty() && type.isNotEmpty()) {
                l.mimeType = DownloadLogic.mimeBase(type)
                if (!l.filename.contains('.')) l.filename = DownloadLogic.filenameFor(l.url, null, l.mimeType, DownloadSink::extensionFor)
            }
            if (l.sink == null) l.sink = createSink(l)
            l.received = 0
            report(l, "progressing", force = true)
            l.sink!!.open(false).use { out ->
                var offset = 0L
                while (l.total < 0 || offset < l.total) {
                    if (l.control == Control.CANCEL) throw Cancelled()
                    val chunk = evalInPage(
                        l,
                        "(async()=>{const b=window.__zeniumBlobs[$key].slice($offset,${offset + BLOB_CHUNK});" +
                            "const u=new Uint8Array(await b.arrayBuffer());let s='';" +
                            "for(let i=0;i<u.length;i+=32768)s+=String.fromCharCode.apply(null,u.subarray(i,i+32768));return btoa(s)})()"
                    ) as? String ?: throw IOException("the page stopped answering")
                    if (chunk.isEmpty()) break
                    val bytes = Base64.getDecoder().decode(chunk)
                    out.write(bytes)
                    offset += bytes.size
                    l.received = offset
                    report(l, "progressing")
                    if (bytes.size < BLOB_CHUNK) break
                }
                if (l.total < 0) l.total = offset
            }
            main.post { completed(l) }
        } finally {
            runCatching { evalInPage(l, "(function(){if(window.__zeniumBlobs)delete window.__zeniumBlobs[$key];return true})()") }
        }
    }

    /** Run a script in the source tab from the I/O thread and wait for its (JSON) value. */
    private fun evalInPage(l: Live, code: String): Any? {
        val queue = ArrayBlockingQueue<String>(1)
        main.post {
            val tab = l.sourceTabId?.let { host.tabs.get(it) }
            if (tab == null) queue.offer("{\"__zenError\":\"the page is gone\"}")
            else tab.evaluate(code) { result -> queue.offer(result ?: "null") }
        }
        val text = queue.poll(60, TimeUnit.SECONDS) ?: throw IOException("the page did not answer")
        val value = runCatching { JSONTokener(text).nextValue() }.getOrNull()
        if (value is JSONObject && value.has("__zenError")) throw IOException(value.str("__zenError"))
        return value
    }

    private fun createSink(l: Live): DownloadSink {
        val sink = when (val d = l.destination) {
            is Destination.Document -> DownloadSink.forDocument(activity, d.uri, l.filename)
            is Destination.Folder -> runCatching { DownloadSink.createInFolder(activity, d.tree, l.filename, l.mimeType) }
                .getOrElse { DownloadSink.createDefault(activity, l.filename, l.mimeType) }
            Destination.Default -> DownloadSink.createDefault(activity, l.filename, l.mimeType)
        }
        l.finalName = sink.displayName.removeSuffix(DownloadLogic.PARTIAL_SUFFIX)
        return sink
    }

    /** The name shown for the transfer: what is on disk once a sink exists, the suggestion before. */
    private fun displayName(l: Live): String = l.finalName.ifEmpty { l.filename }

    // ---------------------------------------------------------------------------------------------
    // Reporting (main thread → core and notification)
    // ---------------------------------------------------------------------------------------------

    private fun report(l: Live, state: String, force: Boolean = false) {
        val now = SystemClock.elapsedRealtime()
        if (!force && now - l.lastReport < 250) return
        l.lastReport = now
        main.post {
            if (live[l.token] !== l) return@post
            emit(
                "download.progress",
                json(
                    "token" to l.token, "receivedBytes" to l.received, "totalBytes" to l.total.coerceAtLeast(0),
                    "state" to state, "canResume" to l.canResume, "etag" to l.etag, "lastModified" to l.lastModified,
                    "savePath" to (l.sink?.savePath ?: ""), "filename" to l.filename, "finalName" to l.finalName,
                    "mimeType" to l.mimeType
                )
            )
            l.coreId?.let { notifications.progress(it, displayName(l), l.received, l.total, paused = state == "paused", private = l.isPrivate) }
        }
    }

    private fun paused(l: Live) {
        l.lastReport = 0
        report(l, "paused", force = true)
    }

    private fun interrupted(l: Live, reason: String, resumable: Boolean) {
        l.canResume = resumable && l.sink != null
        if (!l.canResume) l.sink?.delete()
        done(l, "interrupted", error = reason)
        l.coreId?.let { notifications.failed(it, displayName(l), reason, private = l.isPrivate) }
    }

    private fun completed(l: Live) {
        if (l.total <= 0) l.total = l.received
        done(l, "completed")
        l.coreId?.let { notifications.dismiss(it) }
    }

    private fun done(l: Live, state: String, error: String? = null) {
        if (live.remove(l.token) == null) return
        l.coreId?.let { if (byCoreId[it] === l) byCoreId.remove(it) }
        val keepFile = state == "completed" || (state == "interrupted" && l.canResume)
        emit(
            "download.done",
            json(
                "token" to l.token, "state" to state,
                "savePath" to (if (keepFile) l.sink?.savePath ?: "" else ""),
                "filename" to l.filename, "finalName" to displayName(l),
                "receivedBytes" to l.received, "totalBytes" to l.total.coerceAtLeast(0),
                "canResume" to (state == "interrupted" && l.canResume), "error" to error, "mimeType" to l.mimeType
            )
        )
        if (state != "interrupted") l.coreId?.let { notifications.dismiss(it) }
    }

    private fun emit(name: String, payload: JSONObject) {
        if (Looper.myLooper() == Looper.getMainLooper()) host.hostEvent(name, payload)
        else main.post { host.hostEvent(name, payload) }
    }

    private fun shareUri(savePath: String): Uri? = when {
        savePath.isEmpty() -> null
        savePath.startsWith("content:") -> Uri.parse(savePath)
        savePath.startsWith("file:") -> Uri.parse(savePath).path?.let { shareableUri(File(it)) }
        else -> shareableUri(File(savePath))
    }

    /**
     * A URI another app may open `file` through: the MediaStore row of a file in the public
     * Downloads (a screenshot; see `Host.saveToDownloads`), else the app's own FileProvider.
     */
    private fun shareableUri(file: File): Uri? {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) mediaStoreUri(file)?.let { return it }
        return fileProviderUri(file)
    }

    @Suppress("DEPRECATION") // DATA: the one column that names the file on disk
    private fun mediaStoreUri(file: File): Uri? = runCatching {
        val collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI
        activity.contentResolver.query(
            collection, arrayOf(MediaStore.MediaColumns._ID),
            "${MediaStore.MediaColumns.DATA} = ?", arrayOf(file.absolutePath), null
        )?.use { c -> if (c.moveToFirst()) ContentUris.withAppendedId(collection, c.getLong(0)) else null }
    }.getOrNull()

    private fun fileProviderUri(file: File): Uri? = runCatching {
        FileProvider.getUriForFile(activity, "${activity.packageName}.files", file)
    }.getOrNull()

    private fun defaultUserAgent(): String = runCatching { WebSettings.getDefaultUserAgent(activity) }.getOrDefault("Mozilla/5.0 (Linux; Android) Zenium")

    private fun toast(text: String) {
        main.post { Toast.makeText(activity, text, Toast.LENGTH_SHORT).show() }
    }

    companion object {
        /** Raw bytes per blob slice; base64 grows it by a third, comfortably inside the bridge's limits. */
        private const val BLOB_CHUNK = 512 * 1024
        /** The core's `PRIVATE_CONTAINER_ID`: tabs of a private window run in this container. */
        const val PRIVATE_CONTAINER = "private"
    }
}
