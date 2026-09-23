package app.zen.chromium.ext

import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.provider.OpenableColumns
import android.util.Log
import android.webkit.WebSettings
import androidx.core.content.IntentCompat
import app.zen.chromium.BackgroundWorkHold
import app.zen.chromium.BuildConfig
import app.zen.chromium.Host
import app.zen.chromium.Storage
import app.zen.chromium.arr
import app.zen.chromium.json
import app.zen.chromium.num
import app.zen.chromium.str
import app.zen.chromium.strOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.concurrent.ExecutorService

/**
 * The Kotlin half of the extension store (the TypeScript half is `src/android/extensionHost.ts`
 * with `extensionStoreIo.ts` as the contract): it moves bytes and files, the core decides.
 *
 *  - `extStore.fetch` downloads to a package file under `cache/ext-packages/<token>`, which the
 *    chrome document reads through the asset loader (`ChromeWebView`, `/ext-packages/`); the
 *    core verifies the CRX3 signature and parses the archive from those bytes.
 *  - `extStore.unpack` writes the entries the core listed from the same file straight into a
 *    version directory under `files/zen/extensions/<id>/` ([ExtensionFiles]), so the unpacked
 *    files never cross the bridge either.
 *  - `extStore.pick` and the `VIEW` / `SEND` intents for `.crx` and `.zip` files copy the chosen
 *    document into a package file and hand the host a handle; a sideload that arrives before the
 *    chrome is up waits in [sideloads] for `extStore.takeSideloads`.
 *  - `extStore.remove`, `prune` and `sweep` keep the install directory and the cache tidy;
 *    remove also takes the runtime's storage for the extension.
 *
 * Installed files are served to the chrome under `/ext-files/` for the list's icons. The bridge
 * methods run on the main thread and answer from `io`.
 */
class ExtensionStore(private val host: Host, private val io: ExecutorService, private val main: Handler) {
    val files = ExtensionFiles(File(host.activity.filesDir, ROOT_DIR))
    val packagesDir = File(host.activity.cacheDir, PACKAGES_DIR)
    private val fetcher = PackageFetcher(packagesDir, runCatching { WebSettings.getDefaultUserAgent(host.activity) }.getOrNull())
    /** Tokens this process handed out: what `sweep` leaves alone. */
    private val live = HashSet<String>()
    /** Packages another app handed us that the host has not collected yet ([SideloadQueue]). */
    private val sideloads = SideloadQueue()

    /** `files/zen/extensions`, what every managed registry path starts with (the boot payload names it). */
    val root: File get() = files.root

    // --- bridge methods ------------------------------------------------------------------------

    fun fetch(url: String, maxBytes: Long, reply: (Any?) -> Unit) {
        val limit = if (maxBytes > 0) maxBytes else DEFAULT_MAX_PACKAGE_BYTES
        io.execute {
            val started = System.nanoTime()
            val result = runCatching { fetcher.fetch(url, limit) }
            main.post {
                result.fold(
                    { r ->
                        val token = r.file?.name
                        if (token != null) live.add(token)
                        Log.i(TAG, "fetched $url: HTTP ${r.status}, ${r.size} bytes in ${(System.nanoTime() - started) / 1_000_000} ms")
                        reply(json("status" to r.status, "url" to r.url, "size" to r.size, "token" to token))
                    },
                    { e -> reply(Host.Rejection(e.message ?: e.javaClass.simpleName)) }
                )
            }
        }
    }

    fun unpack(args: JSONObject, reply: (Any?) -> Unit) {
        val file = packageFile(args.str("token"))
        if (file == null || !file.isFile) {
            reply(Host.Rejection("the package file is gone"))
            return
        }
        val request = ExtensionFiles.UnpackRequest(
            id = args.str("id"),
            version = args.str("version"),
            zipOffset = args.num("zipOffset").toLong(),
            rootPrefix = args.str("rootPrefix"),
            files = args.arr("files").strings(),
            directories = args.arr("directories").strings(),
            manifest = args.strOrNull("manifest"),
            totalSize = args.num("totalSize").toLong()
        )
        io.execute {
            val started = System.nanoTime()
            val result = runCatching { files.unpack(file, request) }
            main.post {
                result.fold(
                    { dir ->
                        Log.i(TAG, "unpacked ${request.id} ${request.version} (${request.files.size} files) in ${(System.nanoTime() - started) / 1_000_000} ms")
                        reply(json("dir" to dir.absolutePath))
                    },
                    { e ->
                        Log.w(TAG, "unpack of ${request.id} ${request.version} failed", e)
                        reply(Host.Rejection(e.message ?: e.javaClass.simpleName))
                    }
                )
            }
        }
    }

    fun discard(token: String) {
        val file = packageFile(token) ?: return
        live.remove(token)
        io.execute { file.delete() }
    }

    /** Uninstall: every version directory, and the storage and rule cache the runtime kept for the id. */
    fun remove(id: String, reply: (Any?) -> Unit) {
        io.execute {
            val result = runCatching {
                files.remove(id)
                File(host.activity.filesDir, "zen/${Storage.EXT_STORAGE_DIR}/$id.json").delete()
                File(host.activity.cacheDir, "ext-rules/$id").deleteRecursively()
            }
            main.post { reply(result.exceptionOrNull()?.let { Host.Rejection(it.message ?: it.javaClass.simpleName) }) }
        }
    }

    fun prune(id: String, keep: String, reply: (Any?) -> Unit) {
        io.execute {
            val result = runCatching { JSONArray(files.prune(id, File(keep))) }
            main.post { reply(result.getOrElse { Host.Rejection(it.message ?: it.javaClass.simpleName) }) }
        }
    }

    /** Staging folders of interrupted installs and package files no live token names. */
    fun sweep(reply: (Any?) -> Unit) {
        val keep = HashSet(live)
        io.execute {
            val staging = runCatching { files.sweepStaging() }.getOrDefault(emptyList())
            var packages = 0
            for (file in packagesDir.listFiles() ?: emptyArray()) {
                if (file.name in keep) continue
                if (file.delete()) packages++
            }
            main.post { reply(json("staging" to JSONArray(staging), "packages" to packages)) }
        }
    }

    /** The system document picker; answers with a handle, or null when dismissed or unreadable. */
    fun pick(reply: (Any?) -> Unit) {
        host.activity.pickExtensionPackage { uri ->
            if (uri == null) reply(null) else importPackage(uri) { handle -> reply(handle) }
        }
    }

    /**
     * Handles queued by [sideload]; the host installs them and the queue empties. Answers at
     * once, or once a quiet handover's import in flight has landed ([SideloadQueue.take]).
     */
    fun takeSideloads(reply: (JSONArray) -> Unit) = sideloads.take(reply)

    // --- packages from other apps ---------------------------------------------------------------

    /**
     * A `VIEW` or `SEND` intent carrying a `.crx` or `.zip`: the document is copied to a package
     * file and queued; the chrome is told there is something to collect – unless the intent asks
     * for the quiet handover ([EXTRA_QUIET_HANDOVER], honoured by debuggable builds alone: the
     * drivers' still of the prompt on the fallback path), where the store's `start()` collects
     * it as after a cold start, with no window to show the chrome's own sheet ([SideloadQueue]).
     * False when the intent carries no package (the caller handles it as before).
     */
    fun sideload(intent: Intent): Boolean {
        val uri = packageUri(intent) ?: return false
        val quiet = BackgroundWorkHold.requested(intent.getBooleanExtra(EXTRA_QUIET_HANDOVER, false), BuildConfig.DEBUG)
        sideloads.beginImport(quiet)
        importPackage(uri) { handle ->
            if (handle == null) Log.w(TAG, "could not read the package $uri")
            if (sideloads.endImport(quiet, handle)) host.chrome.hostEvent("extension.sideload", json("count" to sideloads.size))
        }
        return true
    }

    /**
     * The document a `VIEW` or `SEND` intent carries, when it looks like an extension package:
     * by its type, or by a `.crx` / `.zip` name where the sender typed it loosely.
     */
    fun packageUri(intent: Intent): Uri? {
        val uri = when (intent.action) {
            Intent.ACTION_VIEW -> intent.data
            Intent.ACTION_SEND -> IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
            else -> null
        } ?: return null
        if (uri.scheme != "content" && uri.scheme != "file") return null
        if (intent.type in PACKAGE_MIME_TYPES) return uri
        return if (isPackageName(displayNameOf(uri) ?: "")) uri else null
    }

    /** Copies the document behind `uri` to a package file (on `io`) and answers with its handle. */
    private fun importPackage(uri: Uri, done: (JSONObject?) -> Unit) {
        io.execute {
            val name = displayNameOf(uri) ?: "package"
            val handle = runCatching {
                if (!packagesDir.isDirectory && !packagesDir.mkdirs()) throw IOException("could not create ${packagesDir.path}")
                val file = File(packagesDir, PackageFetcher.newToken())
                var size = 0L
                try {
                    val input = host.activity.contentResolver.openInputStream(uri) ?: throw IOException("cannot open $uri")
                    input.use { source ->
                        FileOutputStream(file).use { out ->
                            val buffer = ByteArray(64 * 1024)
                            while (true) {
                                val n = source.read(buffer)
                                if (n < 0) break
                                size += n
                                if (size > DEFAULT_MAX_PACKAGE_BYTES) throw IOException("$name is larger than $DEFAULT_MAX_PACKAGE_BYTES bytes")
                                out.write(buffer, 0, n)
                            }
                        }
                    }
                } catch (e: Exception) {
                    file.delete()
                    throw e
                }
                json("token" to file.name, "name" to name, "size" to size)
            }.onFailure { Log.w(TAG, "could not import $uri", it) }.getOrNull()
            main.post {
                if (handle != null) live.add(handle.str("token"))
                done(handle)
            }
        }
    }

    private fun displayNameOf(uri: Uri): String? {
        if (uri.scheme == "content") {
            runCatching {
                host.activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                    if (cursor.moveToFirst()) cursor.getString(0)?.takeIf { it.isNotBlank() }?.let { return it }
                }
            }
        }
        return uri.lastPathSegment?.substringAfterLast('/')?.takeIf { it.isNotBlank() }
    }

    /** The file behind a token; null for anything that is not a token (a path could not sneak in). */
    private fun packageFile(token: String): File? =
        if (PackageFetcher.isToken(token)) File(packagesDir, token) else null

    private fun JSONArray.strings(): List<String> = List(length()) { i -> optString(i) }

    companion object {
        private const val TAG = "ZenExtStore"
        /** Under `files/`: the install root, `files/zen/extensions/<id>/<version>/`. */
        const val ROOT_DIR = "zen/extensions"
        /** Under `cache/`: downloaded and imported package files, one per token. */
        const val PACKAGES_DIR = "ext-packages"
        /** The host names its own cap (`MAX_PACKAGE_BYTES`); this is the fallback for a call without one. */
        const val DEFAULT_MAX_PACKAGE_BYTES = 256L * 1024 * 1024
        const val CRX_MIME_TYPE = "application/x-chrome-extension"
        /**
         * A `VIEW` / `SEND` intent's boolean extra asking for the quiet handover ([sideload],
         * [SideloadQueue]); honoured by debuggable builds alone (the drivers: `ExtensionSheetStills`).
         */
        const val EXTRA_QUIET_HANDOVER = "app.zen.chromium.extra.QUIET_HANDOVER"
        val PACKAGE_MIME_TYPES = setOf(CRX_MIME_TYPE, "application/zip", "application/x-zip-compressed")
        /** What the document picker offers; `octet-stream` for providers that do not know `.crx`. */
        val PICKER_MIME_TYPES = arrayOf(CRX_MIME_TYPE, "application/zip", "application/x-zip-compressed", "application/octet-stream")

        fun isPackageName(name: String): Boolean = name.endsWith(".crx", ignoreCase = true) || name.endsWith(".zip", ignoreCase = true)
    }
}
