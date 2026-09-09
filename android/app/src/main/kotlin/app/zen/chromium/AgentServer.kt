package app.zen.chromium

import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * The socket side of the MCP server on Android. The browser core (protocol, sessions, tools) runs
 * in the chrome WebView, exactly as on the desktop; this class only accepts HTTP connections and
 * hands each request to the core through the JS bridge (`agent.request` → `agent.reply`).
 *
 * It binds to loopback by default; local-network access is opt-in. A handler thread blocks on the
 * per-request reply queue while the core answers on the main thread.
 */
class AgentServer(private val host: Host) {
    private val main = Handler(Looper.getMainLooper())
    private val workers = Executors.newCachedThreadPool { r -> Thread(r, "zen-agent").apply { isDaemon = true } }
    private val pending = ConcurrentHashMap<Int, ArrayBlockingQueue<JSONObject>>()
    private val seq = AtomicInteger(0)
    private var server: ServerSocket? = null
    private var acceptor: Thread? = null

    /** Bind and start accepting. Returns `{ port, lanAddresses }`. Throws when the port is taken. */
    fun start(port: Int, lan: Boolean): JSONObject {
        stop()
        val bind = if (lan) InetAddress.getByName("0.0.0.0") else InetAddress.getByName("127.0.0.1")
        val socket = ServerSocket()
        socket.reuseAddress = true
        socket.bind(InetSocketAddress(bind, port))
        server = socket
        val boundPort = socket.localPort
        val thread = Thread({ acceptLoop(socket) }, "zen-agent-accept").apply { isDaemon = true }
        acceptor = thread
        thread.start()
        val lanAddresses = JSONArray()
        if (lan) for (addr in lanAddresses()) lanAddresses.put(addr)
        return json("port" to boundPort, "lanAddresses" to lanAddresses)
    }

    fun stop() {
        val socket = server
        server = null
        acceptor = null
        runCatching { socket?.close() }
        for (queue in pending.values) runCatching { queue.offer(SERVER_STOPPED) }
        pending.clear()
    }

    /** The core answered request `id`; hand the response to its waiting handler thread. */
    fun reply(id: Int, response: JSONObject) {
        pending.remove(id)?.offer(response)
    }

    private fun acceptLoop(socket: ServerSocket) {
        while (!socket.isClosed && server === socket) {
            val client = try {
                socket.accept()
            } catch (e: Exception) {
                if (server === socket) Log.w(TAG, "accept failed", e)
                break
            }
            workers.execute { handle(client) }
        }
    }

    private fun handle(client: Socket) {
        client.use {
            it.soTimeout = 30_000
            val input = BufferedInputStream(it.getInputStream())
            val request = try {
                parseRequest(input, it.inetAddress?.hostAddress ?: "")
            } catch (e: Exception) {
                writeResponse(it.getOutputStream(), 400, mapOf("content-type" to "text/plain"), "Bad Request")
                return
            } ?: return
            val id = seq.incrementAndGet()
            val queue = ArrayBlockingQueue<JSONObject>(1)
            pending[id] = queue
            request.put("id", id)
            main.post { host.chrome.hostEvent("agent.request", request) }
            val response = try {
                queue.poll(30, TimeUnit.SECONDS)
            } catch (e: InterruptedException) {
                null
            }
            pending.remove(id)
            if (response == null || response === SERVER_STOPPED) {
                writeResponse(it.getOutputStream(), 503, mapOf("content-type" to "text/plain"), "MCP server unavailable")
                return
            }
            val headers = HashMap<String, String>()
            val h = response.optJSONObject("headers")
            if (h != null) for (key in h.keys()) headers[key] = h.getString(key)
            writeResponse(it.getOutputStream(), response.optInt("status", 200), headers, response.optString("body", ""))
        }
    }

    /** Minimal HTTP/1.1 request reader: request line, headers, and a Content-Length body. */
    private fun parseRequest(input: BufferedInputStream, remote: String): JSONObject? {
        val requestLine = readLine(input) ?: return null
        val parts = requestLine.split(" ")
        if (parts.size < 2) return null
        val method = parts[0]
        val url = parts[1]
        val headers = JSONObject()
        var contentLength = 0
        while (true) {
            val line = readLine(input) ?: break
            if (line.isEmpty()) break
            val colon = line.indexOf(':')
            if (colon <= 0) continue
            val name = line.substring(0, colon).trim().lowercase()
            val value = line.substring(colon + 1).trim()
            headers.put(name, value)
            if (name == "content-length") contentLength = value.toIntOrNull() ?: 0
        }
        var body = ""
        if (contentLength > 0) {
            if (contentLength > MAX_BODY) return null
            val buffer = ByteArray(contentLength)
            var read = 0
            while (read < contentLength) {
                val n = input.read(buffer, read, contentLength - read)
                if (n < 0) break
                read += n
            }
            body = String(buffer, 0, read, Charsets.UTF_8)
        }
        return json(
            "method" to method,
            "url" to url,
            "headers" to headers,
            "body" to body,
            "remoteAddress" to remote
        )
    }

    /** Reads a CRLF/LF-terminated line as ASCII (header bytes are ASCII). */
    private fun readLine(input: BufferedInputStream): String? {
        val out = StringBuilder()
        var b = input.read()
        if (b < 0) return null
        while (b >= 0) {
            if (b == '\n'.code) break
            if (b != '\r'.code) out.append(b.toChar())
            b = input.read()
        }
        return out.toString()
    }

    private fun writeResponse(out: OutputStream, status: Int, headers: Map<String, String>, body: String) {
        val bytes = body.toByteArray(Charsets.UTF_8)
        val sb = StringBuilder()
        sb.append("HTTP/1.1 ").append(status).append(' ').append(statusText(status)).append("\r\n")
        val sent = HashMap<String, String>()
        for ((k, v) in headers) {
            sb.append(k).append(": ").append(v).append("\r\n")
            sent[k.lowercase()] = v
        }
        if (!sent.containsKey("content-type") && bytes.isNotEmpty()) sb.append("Content-Type: application/json\r\n")
        sb.append("Content-Length: ").append(bytes.size).append("\r\n")
        sb.append("Connection: close\r\n\r\n")
        runCatching {
            out.write(sb.toString().toByteArray(Charsets.UTF_8))
            if (bytes.isNotEmpty()) out.write(bytes)
            out.flush()
        }
    }

    private fun statusText(status: Int): String = when (status) {
        200 -> "OK"
        202 -> "Accepted"
        204 -> "No Content"
        400 -> "Bad Request"
        403 -> "Forbidden"
        404 -> "Not Found"
        405 -> "Method Not Allowed"
        500 -> "Internal Server Error"
        503 -> "Service Unavailable"
        else -> "OK"
    }

    private fun lanAddresses(): List<String> {
        val out = ArrayList<String>()
        runCatching {
            for (iface in NetworkInterface.getNetworkInterfaces()) {
                if (!iface.isUp || iface.isLoopback) continue
                for (addr in iface.inetAddresses) {
                    if (!addr.isLoopbackAddress && addr.hostAddress?.contains('.') == true) {
                        addr.hostAddress?.let(out::add)
                    }
                }
            }
        }
        return out
    }

    companion object {
        private const val TAG = "ZenAgent"
        private const val MAX_BODY = 8 * 1024 * 1024
        private val SERVER_STOPPED = JSONObject()
    }
}
