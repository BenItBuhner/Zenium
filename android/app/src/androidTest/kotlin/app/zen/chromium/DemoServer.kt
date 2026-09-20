package app.zen.chromium

import android.util.Log
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket

/**
 * A page server on the loopback interface for demos whose pages must be exactly known (a link
 * that opens a tab, a text field, a paragraph to select): the instrumentation shares the app's
 * process, so a driver can serve its own pages and need nothing from the network or the runner.
 *
 * `routes` maps a path (`/`, `/second.html`) to a content type and body; anything else is a 404.
 * Everything is `Cache-Control: no-store`, so a reload fetches again. `address` is the loopback
 * address to listen on – 127.0.0.1 unless a demo needs several sites, which are told apart by
 * host: any 127.x.y.z is the loopback too, so one server per address on one port gives each
 * site its own host. A path in `delays` answers that many milliseconds late: a slow script or
 * image, for a page that takes its time to load.
 */
class DemoServer(
    private val port: Int,
    private val routes: Map<String, Pair<String, ByteArray>>,
    private val address: String = "127.0.0.1",
    private val delays: Map<String, Long> = emptyMap()
) : Thread("demo-server-$address-$port") {
    // Android's InetAddress.getLoopbackAddress() is ::1; a socket bound to it alone refuses the
    // 127.0.0.1 the pages' URLs name, so bind the IPv4 loopback explicitly.
    private val socket = ServerSocket(port, 16, InetAddress.getByAddress(ipv4(address)))
    @Volatile private var closed = false

    val origin: String get() = "http://$address:$port"

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
            while (true) {
                val header = request.readLine()
                if (header.isNullOrEmpty()) break
                if (header.startsWith("Range:", ignoreCase = true)) range = header.substringAfter(':').trim()
            }
            val path = line.split(' ').getOrNull(1)?.substringBefore('?') ?: "/"
            delays[path]?.let { Thread.sleep(it) }
            val route = routes[path]
            val (type, body) = route ?: ("text/plain; charset=utf-8" to "no such page: $path\n".toByteArray())
            // A media element fetches its file in byte ranges (the header, then the part it plays,
            // the part a seek lands in): a satisfiable `Range` gets that part as a 206, the way a
            // real server answers, so a WAV or an MP4 is seekable in the WebView.
            val part = if (route != null) range?.let { r -> byteRange(r, body.size) } else null
            val out = it.getOutputStream()
            val head = StringBuilder()
            if (part != null) {
                val (from, to) = part
                head.append("HTTP/1.1 206 Partial Content\r\nContent-Range: bytes $from-$to/${body.size}\r\n")
                    .append("Content-Length: ${to - from + 1}\r\n")
            } else {
                head.append("HTTP/1.1 ${if (route != null) "200 OK" else "404 Not Found"}\r\nContent-Length: ${body.size}\r\n")
            }
            head.append("Content-Type: $type\r\nAccept-Ranges: bytes\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n")
            out.write(head.toString().toByteArray())
            if (part != null) out.write(body, part.first, part.second - part.first + 1) else out.write(body)
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
