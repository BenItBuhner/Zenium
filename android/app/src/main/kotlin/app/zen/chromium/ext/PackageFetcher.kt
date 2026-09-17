package app.zen.chromium.ext

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.SecureRandom

/**
 * The extension store's downloads: Omaha update-check responses (a few KB of XML) and the
 * packages themselves (a CRX3 from the Chrome Web Store or Edge Add-ons; uBlock Origin Lite is
 * 9.7 MB, Adblock Plus 75 MB). The body goes to a file under `dir` named by a random token and
 * never through the JS bridge: the chrome document reads it back through the WebView's asset
 * loader (`ExtensionStore.kt`), and the file stays until the host discards it. Redirects are
 * followed by hand because `HttpURLConnection` refuses to cross schemes on its own and the Edge
 * CDN answers with one. Plain JVM (`java.net`), so the unit tests run it against a local server.
 */
class PackageFetcher(private val dir: File, private val userAgent: String? = null) {
    class Result(val status: Int, val url: String, val size: Long, val file: File?)

    /**
     * Fetches `url`, following redirects. A 2xx body is written to a new file (`Result.file`,
     * whose name is the token) unless it is larger than `maxBytes`; any other status comes back
     * without a file. Connection and read failures throw.
     */
    fun fetch(url: String, maxBytes: Long): Result {
        if (!dir.isDirectory && !dir.mkdirs()) throw IOException("could not create ${dir.path}")
        val connection = open(url)
        try {
            val status = connection.responseCode
            val finalUrl = connection.url.toString()
            if (status !in 200..299) return Result(status, finalUrl, 0, null)
            val declared = connection.contentLengthLong
            if (declared > maxBytes) throw IOException("the download is $declared bytes; the limit is $maxBytes")
            val file = File(dir, newToken())
            var size = 0L
            try {
                connection.inputStream.use { input ->
                    FileOutputStream(file).use { out ->
                        val buffer = ByteArray(BUFFER_SIZE)
                        while (true) {
                            val n = input.read(buffer)
                            if (n < 0) break
                            size += n
                            if (size > maxBytes) throw IOException("the download passed the limit of $maxBytes bytes")
                            out.write(buffer, 0, n)
                        }
                    }
                }
                if (declared >= 0 && size != declared) throw IOException("the download is $size bytes, the server announced $declared")
            } catch (e: Exception) {
                file.delete()
                throw e
            }
            return Result(status, finalUrl, size, file)
        } finally {
            connection.disconnect()
        }
    }

    private fun open(url: String): HttpURLConnection {
        var current = URL(url)
        for (hop in 0..MAX_REDIRECTS) {
            if (current.protocol != "https" && current.protocol != "http") throw IOException("unsupported URL scheme: ${current.protocol}")
            val connection = (current.openConnection() as HttpURLConnection).apply {
                connectTimeout = CONNECT_TIMEOUT_MS
                readTimeout = READ_TIMEOUT_MS
                instanceFollowRedirects = false
                useCaches = false
                // Packages are compressed already; an identity body keeps Content-Length honest.
                setRequestProperty("Accept-Encoding", "identity")
                setRequestProperty("Accept", "*/*")
                if (userAgent != null) setRequestProperty("User-Agent", userAgent)
            }
            val status = connection.responseCode
            if (status !in REDIRECT_STATUSES) return connection
            val location = connection.getHeaderField("Location")
            connection.disconnect()
            if (location == null) throw IOException("redirect (HTTP $status) without a location")
            if (hop == MAX_REDIRECTS) break
            current = URL(current, location)
        }
        throw IOException("too many redirects")
    }

    companion object {
        /** Connecting to a store that does not answer gives up after this. */
        const val CONNECT_TIMEOUT_MS = 30_000
        /** Between two reads (the whole transfer may take longer for a large package on a slow link). */
        const val READ_TIMEOUT_MS = 120_000
        const val MAX_REDIRECTS = 10
        private const val BUFFER_SIZE = 64 * 1024
        private val REDIRECT_STATUSES = setOf(301, 302, 303, 307, 308)
        private val random = SecureRandom()
        private val TOKEN = Regex("^[0-9a-f]{32}$")

        /** A package token is 32 hex characters; anything else never names a file. */
        fun isToken(token: String): Boolean = TOKEN.matches(token)

        fun newToken(): String = ByteArray(16).also(random::nextBytes).joinToString("") { "%02x".format(it) }
    }
}
