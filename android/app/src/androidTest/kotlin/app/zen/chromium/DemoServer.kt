package app.zen.chromium

import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket

/**
 * A page server on the loopback interface for demos whose pages must be exactly known (a link
 * that opens a tab, a text field, a paragraph to select): the instrumentation shares the app's
 * process, so a driver can serve its own pages and need nothing from the network or the runner.
 *
 * `routes` maps a path (`/`, `/second.html`) to a content type and body; anything else is a 404.
 * Everything is `Cache-Control: no-store`, so a reload fetches again.
 */
class DemoServer(private val port: Int, private val routes: Map<String, Pair<String, ByteArray>>) :
    Thread("demo-server-$port") {
    // Android's InetAddress.getLoopbackAddress() is ::1; a socket bound to it alone refuses the
    // 127.0.0.1 the pages' URLs name, so bind the IPv4 loopback explicitly.
    private val socket = ServerSocket(port, 16, InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1)))
    @Volatile private var closed = false

    val origin: String get() = "http://127.0.0.1:$port"

    /** Fetch `/` the way the WebView will and describe the outcome. */
    fun selfCheck(): String = runCatching {
        Socket("127.0.0.1", port).use { s ->
            s.soTimeout = 5_000
            s.getOutputStream().write("GET / HTTP/1.1\r\nHost: 127.0.0.1:$port\r\n\r\n".toByteArray())
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
            Thread { serve(client) }.start()
        }
    }

    private fun serve(client: Socket) {
        client.use {
            val request = it.getInputStream().bufferedReader()
            val line = request.readLine() ?: return
            while (true) {
                val header = request.readLine()
                if (header.isNullOrEmpty()) break
            }
            val path = line.split(' ').getOrNull(1)?.substringBefore('?') ?: "/"
            val route = routes[path]
            val status = if (route != null) "200 OK" else "404 Not Found"
            val (type, body) = route ?: ("text/plain; charset=utf-8" to "no such page: $path\n".toByteArray())
            val out = it.getOutputStream()
            out.write(
                ("HTTP/1.1 $status\r\nContent-Type: $type\r\nContent-Length: ${body.size}\r\n" +
                    "Cache-Control: no-store\r\nConnection: close\r\n\r\n").toByteArray()
            )
            out.write(body)
            out.flush()
        }
    }

    fun close() {
        closed = true
        runCatching { socket.close() }
    }

    companion object {
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
