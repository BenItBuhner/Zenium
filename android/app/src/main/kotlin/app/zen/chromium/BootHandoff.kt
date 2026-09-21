package app.zen.chromium

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.security.SecureRandom

/**
 * The file-backed handoffs between the Kotlin host and the chrome WebView, for what is too big to
 * travel JSON-quoted through the bridge (a string of megabytes is escaped, copied through JNI,
 * parsed by the JS engine and copied again, all of it on the chrome's main thread):
 *
 *  - Boot documents. The boot payload inlines the core's documents while they are small
 *    ([Storage.bootDocuments]); the rest – a session grown big, an extension's rule-set document –
 *    it lists with their size and version tag, and the chrome fetches each from
 *    `https://appassets.androidplatform.net/zen-docs/<name>` ([document]), streamed from the
 *    profile's file through the WebView's request interception (`ChromeWebView.kt`). The tag
 *    travels as the response's `ETag` too, so the chrome (`src/android/handoff.ts`) can tell a
 *    document rewritten between the payload and the fetch; the Safe Browsing host keeps its
 *    parsed tables by the same tag and re-parses only what changed (`SafeBrowsing.reload`).
 *    The same handler serves the Safe Browsing feed documents (megabytes of prefixes), which
 *    the core reads once it is up rather than at boot (`AndroidStoreIO.read`).
 *  - Fetched bodies. `net.fetch` answers with the body inline up to [NET_INLINE_LIMIT] bytes; a
 *    bigger one (the 11 MB phishing-domains list) is written to a file under the cache directory
 *    as it arrives ([readBody], no further than [NET_BODY_LIMIT]) and the reply names it by
 *    token; the chrome fetches `/zen-net/<token>` ([spilled], which consumes the file) and
 *    releases what it never read ([release]). Files a chrome that went away never released are
 *    swept when the next chrome document boots and at process start ([sweep]).
 *
 * Pure file work, so the JVM tests can exercise it; the WebView answers are built in `ChromeWebView`.
 */
class BootHandoff(private val storage: Storage, private val spillDir: File) {
    /** An answer for the WebView: the status, and for 200 the bytes with their type and version tag. */
    class Answer(val status: Int, val mimeType: String, val etag: String?, val length: Long, val stream: InputStream?) {
        val ok: Boolean get() = status == 200
    }

    /** A fetched body as `net.fetch` reports it: the text itself, or the spill file that holds it. */
    sealed class Body {
        class Inline(val text: String) : Body()
        class Spilled(val token: String, val bytes: Long) : Body()
    }

    /**
     * `/zen-docs/<name>`: one of the documents the handler serves ([Storage.isServedDocument]: the
     * boot documents and the Safe Browsing feed documents), whole, with its ETag; 404 for anything
     * else – a document that is not one of them (the filter text under `blocking/`) is not served
     * here, whether or not it exists.
     */
    fun document(path: String): Answer {
        val name = path.trim('/')
        if (!storage.isServedDocument(name)) return NOT_FOUND
        val doc = storage.open(name) ?: return NOT_FOUND
        return Answer(200, "application/json", doc.etag, doc.length, doc.stream)
    }

    /**
     * Read a fetched body: inline while it stays within `inlineLimit` bytes, otherwise into a
     * spill file – the first bytes buffered so far first, the rest streamed straight from the
     * connection, so the body is never held in memory whole. Decoded as UTF-8 either way (the
     * chrome reads the spill file as `text/plain; charset=utf-8`), as the inline path always was.
     * A body over `maxBytes`, or one whose connection fails midway, leaves no file behind and
     * fails the fetch (an [IOException]); the read stops within a buffer of the cap, inline or
     * spilled, so a caller's small cap (an OpenSearch description's 64 KB) bounds the download
     * itself and not only what is kept of it.
     */
    fun readBody(stream: InputStream, inlineLimit: Int = NET_INLINE_LIMIT, maxBytes: Long = NET_BODY_LIMIT): Body {
        val head = ByteArrayOutputStream()
        val buffer = ByteArray(64 * 1024)
        while (head.size() <= inlineLimit) {
            val n = stream.read(buffer)
            if (n < 0) return Body.Inline(String(head.toByteArray(), Charsets.UTF_8))
            head.write(buffer, 0, n)
            if (head.size() > maxBytes) throw IOException("the body exceeds $maxBytes bytes")
        }
        val token = newToken()
        val file = spillFile(token) ?: throw IllegalStateException("no spill directory")
        try {
            var written = 0L
            FileOutputStream(file).use { out ->
                head.writeTo(out)
                written += head.size()
                while (true) {
                    val n = stream.read(buffer)
                    if (n < 0) break
                    written += n
                    if (written > maxBytes) throw IOException("the body exceeds $maxBytes bytes")
                    out.write(buffer, 0, n)
                }
            }
            return Body.Spilled(token, written)
        } catch (e: Throwable) {
            file.delete()
            throw e
        }
    }

    /**
     * `/zen-net/<token>`: a spilled body, once – the file goes as soon as it is opened (the open
     * stream reads on), so a token is consumed by its first read; 404 for a token that is not a
     * live spill file. [release] covers the body the chrome never reads.
     */
    fun spilled(path: String): Answer {
        val file = spillFile(path.trim('/'))?.takeIf { it.isFile } ?: return NOT_FOUND
        val stream = runCatching { FileInputStream(file) }.getOrNull() ?: return NOT_FOUND
        val length = runCatching { stream.channel.size() }.getOrElse { stream.close(); return NOT_FOUND }
        file.delete()
        return Answer(200, "text/plain", null, length, stream)
    }

    /** The chrome has read the body (or gave up on it): the spill file goes. */
    fun release(token: String) {
        spillFile(token)?.delete()
    }

    /** Delete every spill file: nothing outlives the chrome document that asked for it. */
    fun sweep() {
        spillDir.listFiles()?.forEach { it.delete() }
    }

    /** Tokens are 32 hex digits ([newToken]); anything else names no file. */
    private fun spillFile(token: String): File? {
        if (!TOKEN.matches(token)) return null
        spillDir.mkdirs()
        return File(spillDir, token)
    }

    private fun newToken(): String = ByteArray(16).also(random::nextBytes).joinToString("") { "%02x".format(it) }

    companion object {
        /** The document handler's path prefix (`DOCS_PATH` in `src/android/handoff.ts`). */
        const val DOCS_PATH = "/zen-docs/"
        /** The spilled bodies' path prefix (`NET_PATH` in `src/android/handoff.ts`). */
        const val NET_PATH = "/zen-net/"
        /** Where the spill files live under the cache directory. */
        const val SPILL_DIR = "zen-net"

        /**
         * Boot documents up to this size travel inline in the boot payload; over it, the manifest
         * names them and the chrome fetches them. Around this size one JSON-quoted string costs
         * about what one fetch round trip does, and the fetches run in parallel.
         */
        const val BOOT_INLINE_LIMIT = 64L * 1024

        /**
         * Fetched bodies up to this size are answered inline; the suggestion and manifest replies
         * are far under it, and a filter list or a Safe Browsing feed far over.
         */
        const val NET_INLINE_LIMIT = 256 * 1024

        /**
         * No fetched body is spilled beyond this: a runaway download cannot fill the cache
         * directory. Ten times the biggest feed the core fetches (the 11 MB phishing-domains list).
         */
        const val NET_BODY_LIMIT = 128L * 1024 * 1024

        private val NOT_FOUND = Answer(404, "text/plain", null, 0, null)
        private val TOKEN = Regex("^[0-9a-f]{32}$")
        private val random = SecureRandom()
    }
}
