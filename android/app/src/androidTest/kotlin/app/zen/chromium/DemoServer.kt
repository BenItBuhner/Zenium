package app.zen.chromium

import android.util.Log
import java.io.IOException
import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * A page server on the loopback interface for demos whose pages must be exactly known (a link
 * that opens a tab, a text field, a paragraph to select): the instrumentation shares the app's
 * process, so a driver can serve its own pages and need nothing from the network or the runner.
 *
 * `routes` maps a path (`/`, `/second.html`) to a content type and body; anything else is a 404.
 * Everything is `Cache-Control: no-store`, so a reload fetches again – except the paths in
 * `cacheable`, which the WebView may keep for an hour, for a demo that shows a page coming back
 * without a request (a history navigation). [hits] counts the requests each path has seen, so a
 * driver can tell a page served from the cache from one fetched again. `address` is the
 * loopback address to listen on – 127.0.0.1 unless a demo needs several sites, which are told
 * apart by host: any 127.x.y.z is the loopback too, so one server per address on one port gives
 * each site its own host – and `0.0.0.0` listens on every interface, for a demo whose site must
 * NOT be the loopback (an insecure origin: the device's own network address, [siteAddress]). A
 * path in `delays` answers that many milliseconds late: a slow script or image, for a page that
 * takes its time to load. A path in `redirects` answers `303 See Other` to the location it maps
 * to, whatever the method: a sign-in form's POST landing on its welcome page the way a real
 * site's does (a request body is read to its `Content-Length` first, so the connection closes
 * cleanly). A path in `cuts` is a file whose server drops the connection ([Cut]): what the
 * downloads demos need from the runner's Node server, served from the device instead.
 */
class DemoServer(
    private val port: Int,
    private val routes: Map<String, Pair<String, ByteArray>>,
    private val address: String = "127.0.0.1",
    private val delays: Map<String, Long> = emptyMap(),
    private val cacheable: Set<String> = emptySet(),
    private val redirects: Map<String, String> = emptyMap(),
    private val cuts: Map<String, Cut> = emptyMap()
) : Thread("demo-server-$address-$port") {
    /**
     * A file whose server fails the downloader (the phone's `Downloads.kt`, which fetches a tapped
     * link itself once the WebView has handed it over): after the first full response to the path
     * – the WebView's navigation, which reads the headers and drops its request – the next
     * `responses` responses die, a full one after `at` body bytes, a `Range` one right after its
     * headers (a resume that moves resets the downloader's retry budget; one that does not,
     * counts), and every response after those is served whole. The count is of full responses
     * plus dying ones, so a Range warm-up shifts nothing – the rule `downloads-demo-server.mjs`
     * settled on for dead.bin.
     */
    class Cut(val at: Int, val responses: Int)

    // Android's InetAddress.getLoopbackAddress() is ::1; a socket bound to it alone refuses the
    // 127.0.0.1 the pages' URLs name, so bind the IPv4 loopback explicitly.
    private val socket = ServerSocket(port, 16, InetAddress.getByAddress(ipv4(address)))
    @Volatile private var closed = false
    private val requests = ConcurrentHashMap<String, AtomicInteger>()
    /** Full (non-Range) responses served so far per cut path, and how many responses have died. */
    private val fullResponses = ConcurrentHashMap<String, AtomicInteger>()
    private val deaths = ConcurrentHashMap<String, AtomicInteger>()

    val origin: String get() = "http://$address:$port"

    /** How many requests `path` has answered so far (404s included). */
    fun hits(path: String): Int = requests[path]?.get() ?: 0

    /** How many responses to a cut path have died so far. */
    fun deaths(path: String): Int = deaths[path]?.get() ?: 0

    /** Fetch `/` the way the WebView will and describe the outcome. */
    fun selfCheck(): String = runCatching {
        Socket(address, port).use { s ->
            s.soTimeout = 5_000
            s.getOutputStream().write("GET / HTTP/1.1\r\nHost: $address:$port\r\n\r\n".toByteArray())
            s.getOutputStream().flush()
            val status = s.getInputStream().bufferedReader().readLine()
            "listening on ${socket.localSocketAddress}, GET / -> $status"
        }
    }.getOrElse { e -> "listening on ${socket.localSocketAddress}, GET / failed: $e" }

    override fun run() {
        while (!closed) {
            val client = try {
                socket.accept()
            } catch (_: Exception) {
                if (closed) return else continue
            }
            // A client that hangs up mid-request (a fetch the WebView gave up on, a TLS hello
            // meant for an https server) is its own business: uncaught, the exception would end
            // the instrumentation process, and the demo with it.
            Thread {
                try {
                    serve(client)
                } catch (e: IOException) {
                    Log.i("DemoServer", "client of $origin went away: $e")
                }
            }.start()
        }
    }

    private fun serve(client: Socket) {
        client.use {
            it.soTimeout = 10_000
            val request = it.getInputStream().bufferedReader()
            val line = request.readLine() ?: return
            var range: String? = null
            var contentLength = 0
            while (true) {
                val header = request.readLine()
                if (header.isNullOrEmpty()) break
                if (header.startsWith("Range:", ignoreCase = true)) range = header.substringAfter(':').trim()
                if (header.startsWith("Content-Length:", ignoreCase = true)) {
                    contentLength = header.substringAfter(':').trim().toIntOrNull() ?: 0
                }
            }
            // A body left unread when the socket closes goes back as a reset, which the WebView
            // reports over the response it already has: read it (a form's fields) and drop it.
            var unread = contentLength
            val scratch = CharArray(4096)
            while (unread > 0) {
                val n = request.read(scratch, 0, minOf(unread, scratch.size))
                if (n < 0) break
                unread -= n
            }
            val path = line.split(' ').getOrNull(1)?.substringBefore('?') ?: "/"
            requests.getOrPut(path) { AtomicInteger() }.incrementAndGet()
            delays[path]?.let { Thread.sleep(it) }
            val out = it.getOutputStream()
            redirects[path]?.let { location ->
                out.write(
                    ("HTTP/1.1 303 See Other\r\nLocation: $location\r\nContent-Length: 0\r\n" +
                        "Cache-Control: no-store\r\nConnection: close\r\n\r\n").toByteArray()
                )
                out.flush()
                return
            }
            val route = routes[path]
            val (type, body) = route ?: ("text/plain; charset=utf-8" to "no such page: $path\n".toByteArray())
            // A media element fetches its file in byte ranges (the header, then the part it plays,
            // the part a seek lands in): a satisfiable `Range` gets that part as a 206, the way a
            // real server answers, so a WAV or an MP4 is seekable in the WebView.
            val part = if (route != null) range?.let { r -> byteRange(r, body.size) } else null
            val cache = if (route != null && path in cacheable) "max-age=3600" else "no-store"
            // A cut path: does this response die, and after how many body bytes?
            val cut = cuts[path]?.let { c ->
                val nthFull = if (part == null) fullResponses.getOrPut(path) { AtomicInteger() }.incrementAndGet() else 0
                if (nthFull == 1) return@let null
                val died = deaths.getOrPut(path) { AtomicInteger() }
                if (died.get() >= c.responses) return@let null
                val n = died.incrementAndGet()
                Log.i("DemoServer", "$path: response $n of ${c.responses} dies ${if (part == null) "after ${c.at} bytes" else "after its headers"}")
                if (part == null) c.at else 0
            }
            val head = StringBuilder()
            if (part != null) {
                val (from, to) = part
                head.append("HTTP/1.1 206 Partial Content\r\nContent-Range: bytes $from-$to/${body.size}\r\n")
                    .append("Content-Length: ${to - from + 1}\r\n")
            } else {
                head.append("HTTP/1.1 ${if (route != null) "200 OK" else "404 Not Found"}\r\nContent-Length: ${body.size}\r\n")
            }
            head.append("Content-Type: $type\r\nAccept-Ranges: bytes\r\nCache-Control: $cache\r\nConnection: close\r\n\r\n")
            out.write(head.toString().toByteArray())
            val from = part?.first ?: 0
            val length = part?.let { p -> p.second - p.first + 1 } ?: body.size
            // A dying response closes the socket short of its Content-Length: the client reads what
            // was sent, then the end of the stream where bytes were promised (an IOException on its
            // side, the network giving up as far as the downloader can tell).
            out.write(body, from, if (cut != null) minOf(cut, length) else length)
            out.flush()
        }
    }

    fun close() {
        closed = true
        runCatching { socket.close() }
    }

    companion object {
        /**
         * The first and last byte a `Range` header (`bytes=from-to`, `bytes=from-`, `bytes=-last`)
         * asks for out of `size`, clamped to the body; null when it names nothing satisfiable
         * (the whole body goes as a 200 then).
         */
        fun byteRange(header: String, size: Int): Pair<Int, Int>? {
            val spec = header.removePrefix("bytes=").split(',').firstOrNull()?.trim() ?: return null
            val dash = spec.indexOf('-')
            if (dash < 0 || size <= 0) return null
            val fromText = spec.substring(0, dash)
            val toText = spec.substring(dash + 1)
            val from: Int
            val to: Int
            if (fromText.isEmpty()) {
                val last = toText.toIntOrNull() ?: return null
                if (last <= 0) return null
                from = (size - last).coerceAtLeast(0)
                to = size - 1
            } else {
                from = fromText.toIntOrNull() ?: return null
                to = (toText.toIntOrNull() ?: (size - 1)).coerceAtMost(size - 1)
            }
            if (from < 0 || from > to || from >= size) return null
            return from to to
        }

        /** The four bytes of a dotted IPv4 address (no name lookup, which would go to the network). */
        private fun ipv4(address: String): ByteArray {
            val parts = address.split('.')
            require(parts.size == 4) { "not a dotted IPv4 address: $address" }
            return ByteArray(4) { parts[it].toInt().toByte() }
        }

        /**
         * The device's own IPv4 address on its network (the emulator's `10.0.2.15` on eth0, or its
         * Wi-Fi's `192.168.232.x`): a host that is NOT the loopback, so a page served there is
         * what Chromium's `IsUrlPotentiallyTrustworthy` – and the core's and `DownloadLogic.kt`'s
         * ports of it – call insecure, where `127.0.0.1` is as trustworthy as `https:`. Null on a
         * device with no network interface up.
         */
        fun siteAddress(): String? =
            NetworkInterface.getNetworkInterfaces()?.toList()
                ?.filter { runCatching { it.isUp && !it.isLoopback }.getOrDefault(false) }
                ?.flatMap { it.inetAddresses.toList() }
                ?.firstOrNull { it is Inet4Address && !it.isLoopbackAddress && !it.isLinkLocalAddress }
                ?.hostAddress

        /** A minimal HTML document with a heading, and `body` after it. */
        fun page(title: String, body: String = ""): Pair<String, ByteArray> =
            "text/html; charset=utf-8" to (
                "<!doctype html><html><head><meta charset=utf-8>" +
                    "<meta name=viewport content=\"width=device-width,initial-scale=1\"><title>$title</title>" +
                    "<style>body{margin:0;font-family:sans-serif;color:#15141a}h1{font-size:28px;padding:40px 24px}" +
                    "p{padding:0 24px;font-size:20px}a{color:#1b4332}</style></head>" +
                    "<body><h1>$title</h1>$body</body></html>"
                ).toByteArray()
    }
}
