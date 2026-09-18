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
 * site its own host.
 */
class DemoServer(
    private val port: Int,
    private val routes: Map<String, Pair<String, ByteArray>>,
    private val address: String = "127.0.0.1"
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
