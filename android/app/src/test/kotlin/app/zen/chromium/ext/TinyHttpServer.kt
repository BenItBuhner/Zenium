package app.zen.chromium.ext

import java.io.BufferedReader
import java.io.IOException
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.Locale
import java.util.concurrent.Executors

/**
 * Enough of HTTP/1.1 over a [ServerSocket] for the fetcher tests: a request line, headers, a
 * canned response with `Connection: close`. The JDK's `com.sun.net.httpserver` is not on the
 * Android unit-test compile classpath, so this stands in.
 */
class TinyHttpServer : AutoCloseable {
    class Request(val method: String, val path: String, val headers: Map<String, String>) {
        fun header(name: String): String? = headers[name.lowercase(Locale.ROOT)]
    }

    class Response(val status: Int, val body: ByteArray = ByteArray(0), val headers: Map<String, String> = emptyMap())

    private val socket = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
    private val routes = HashMap<String, (Request) -> Response>()
    private val pool = Executors.newCachedThreadPool()

    val port: Int get() = socket.localPort

    fun route(path: String, handler: (Request) -> Response) {
        routes[path] = handler
    }

    fun start() {
        pool.execute {
            while (!socket.isClosed) {
                val client = try {
                    socket.accept()
                } catch (e: IOException) {
                    break
                }
                pool.execute { serve(client) }
            }
        }
    }

    override fun close() {
        socket.close()
        pool.shutdownNow()
    }

    private fun serve(client: Socket) {
        client.use {
            val reader = BufferedReader(InputStreamReader(client.getInputStream(), Charsets.ISO_8859_1))
            val requestLine = reader.readLine() ?: return
            val parts = requestLine.split(' ')
            if (parts.size < 2) return
            val headers = HashMap<String, String>()
            while (true) {
                val line = reader.readLine() ?: break
                if (line.isEmpty()) break
                val colon = line.indexOf(':')
                if (colon > 0) headers[line.substring(0, colon).trim().lowercase(Locale.ROOT)] = line.substring(colon + 1).trim()
            }
            val request = Request(parts[0], parts[1], headers)
            val response = routes[request.path]?.invoke(request) ?: Response(404, "not found".toByteArray())
            val head = StringBuilder()
            head.append("HTTP/1.1 ").append(response.status).append(' ').append(reason(response.status)).append("\r\n")
            head.append("Content-Length: ").append(response.body.size).append("\r\n")
            head.append("Connection: close\r\n")
            for ((name, value) in response.headers) head.append(name).append(": ").append(value).append("\r\n")
            head.append("\r\n")
            val out = client.getOutputStream()
            out.write(head.toString().toByteArray(Charsets.ISO_8859_1))
            out.write(response.body)
            out.flush()
        }
    }

    private fun reason(status: Int): String = when (status) {
        200 -> "OK"
        301 -> "Moved Permanently"
        302 -> "Found"
        307 -> "Temporary Redirect"
        404 -> "Not Found"
        else -> "Status"
    }
}
