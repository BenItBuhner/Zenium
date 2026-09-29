package app.zen.chromium

import android.util.Log
import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URI
import java.net.URLDecoder
import java.util.Base64
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * A WebDAV server on the loopback interface, as far as the sync engine's transport goes
 * (`src/core/sync/webdav.ts`): PROPFIND `Depth: 0` / `1` answering a SabreDAV-shaped multistatus,
 * GET with `If-None-Match` → 304, PUT with `If-None-Match: *` / `If-Match` → 412 on a failed
 * precondition and 409 without a parent, MKCOL (201 / 405 / 409), MOVE with `Destination` and
 * `Overwrite` (412 when `F` and the target exists), DELETE of a document or a whole collection,
 * OPTIONS, and Basic authentication against a user table (401 with `WWW-Authenticate`). ETags
 * are strong and derived from the content. The instrumentation shares the app's process, so a
 * `SyncWebDavDemo` serves the server the phone syncs with and needs nothing from the network.
 *
 * Every request is logged with its method, path and status ([log]); [hits] counts per method;
 * [failNext] makes the next request of a method answer a status of the driver's choosing (a 412
 * on a MOVE, a 423 on a PUT) so a scene can show the engine's quiet retry. The fixture is the
 * services' `FakeWebDavServer` (`src/core/sync/__tests__/fakeWebDavServer.ts`) on a socket; the
 * `DemoServer`'s static routes have no verbs, so the two are siblings.
 */
class DemoWebDavServer(
    private val port: Int,
    /** The DAV root the credentials point at (`/remote.php/dav/files/alice`), made at start. */
    private val root: String,
    /** User → password; empty means no authentication at all. */
    private val users: Map<String, String>,
    private val address: String = "127.0.0.1"
) : Thread("demo-webdav-$port") {
    class LoggedRequest(val method: String, val path: String, val status: Int, val headers: Map<String, String>)

    private val socket = ServerSocket(port, 16, InetAddress.getByAddress(ipv4(address)))
    @Volatile private var closed = false
    private val collections: MutableSet<String> = ConcurrentHashMap.newKeySet()
    private val documents = ConcurrentHashMap<String, String>()
    private val counts = ConcurrentHashMap<String, AtomicInteger>()
    private val passwords = ConcurrentHashMap<String, String>().apply { putAll(users) }
    /** Method → the status its next request answers with, once. */
    private val failures = ConcurrentHashMap<String, Int>()
    val log: MutableList<LoggedRequest> = Collections.synchronizedList(ArrayList())

    /** The requests answered so far, as one copy a driver can read while more arrive. */
    fun requests(): List<LoggedRequest> = synchronized(log) { log.toList() }

    init {
        mkcolRecursive(normalise(root))
    }

    val origin: String get() = "http://$address:$port"

    /** The DAV root's URL with its trailing slash: what the engine's `WebDavSyncCredentials.url` takes. */
    val rootUrl: String get() = "$origin${normalise(root)}/"

    /** How many requests `method` has answered so far. */
    fun hits(method: String): Int = counts[method]?.get() ?: 0

    /** The next `method` request answers `status`, whatever it asked. */
    fun failNext(method: String, status: Int) {
        failures[method] = status
    }

    /** The account's password from now on (an app password revoked and a new one made). */
    fun setPassword(user: String, password: String) {
        passwords[user] = password
    }

    /** The documents of a collection (`name → text`), or null when there is none. */
    fun files(dirPath: String): Map<String, String>? {
        val dir = normalise(dirPath)
        if (!collections.contains(dir)) return null
        val prefix = "$dir/"
        return documents.filterKeys { it.startsWith(prefix) && !it.substring(prefix.length).contains('/') }
            .mapKeys { it.key.substring(prefix.length) }
    }

    fun hasCollection(path: String): Boolean = collections.contains(normalise(path))

    fun selfCheck(): String = runCatching {
        Socket(address, port).use { s ->
            s.soTimeout = 5_000
            s.getOutputStream().write("OPTIONS ${normalise(root)}/ HTTP/1.1\r\nHost: $address:$port\r\n\r\n".toByteArray())
            s.getOutputStream().flush()
            "listening on ${socket.localSocketAddress}, OPTIONS -> ${s.getInputStream().bufferedReader().readLine()}"
        }
    }.getOrElse { e -> "listening on ${socket.localSocketAddress}, OPTIONS failed: $e" }

    override fun run() {
        while (!closed) {
            val client = try {
                socket.accept()
            } catch (_: Exception) {
                if (closed) return else continue
            }
            Thread {
                try {
                    serve(client)
                } catch (e: IOException) {
                    Log.i(TAG, "client of $origin went away: $e")
                }
            }.start()
        }
    }

    fun close() {
        closed = true
        runCatching { socket.close() }
    }

    // --- one request ---------------------------------------------------------------------------------

    private class Reply(val status: Int, val headers: Map<String, String> = emptyMap(), val body: String = "")

    private fun serve(client: Socket) {
        client.use {
            it.soTimeout = 10_000
            val input = it.getInputStream()
            val line = readLine(input) ?: return
            val parts = line.split(' ')
            val method = parts.getOrNull(0)?.uppercase() ?: return
            val target = parts.getOrNull(1) ?: "/"
            val headers = HashMap<String, String>()
            while (true) {
                val header = readLine(input)
                if (header.isNullOrEmpty()) break
                val colon = header.indexOf(':')
                if (colon > 0) headers[header.substring(0, colon).trim().lowercase()] = header.substring(colon + 1).trim()
            }
            val length = headers["content-length"]?.toIntOrNull() ?: 0
            val body = if (length > 0) String(readBytes(input, length), Charsets.UTF_8) else ""
            val path = normalise(target.substringBefore('?'))
            counts.getOrPut(method) { AtomicInteger() }.incrementAndGet()
            val reply = failures.remove(method)?.let { status -> Reply(status) }
                ?: if (!authorised(headers["authorization"])) {
                    Reply(401, mapOf("WWW-Authenticate" to "Basic realm=\"Zenium demo\""))
                } else {
                    answer(method, path, headers, body)
                }
            log.add(LoggedRequest(method, path, reply.status, headers.filterKeys { it != "authorization" }))
            val head = StringBuilder("HTTP/1.1 ${reply.status} ${reason(reply.status)}\r\n")
            for ((name, value) in reply.headers) head.append("$name: $value\r\n")
            val bytes = reply.body.toByteArray(Charsets.UTF_8)
            head.append("Content-Length: ${bytes.size}\r\nCache-Control: no-store\r\nDAV: 1\r\nConnection: close\r\n\r\n")
            val out = it.getOutputStream()
            out.write(head.toString().toByteArray())
            out.write(bytes)
            out.flush()
        }
    }

    /** Exactly `length` bytes of the body, or what came before the client closed. */
    private fun readBytes(input: InputStream, length: Int): ByteArray {
        val bytes = ByteArray(length)
        var read = 0
        while (read < length) {
            val n = input.read(bytes, read, length - read)
            if (n < 0) return bytes.copyOf(read)
            read += n
        }
        return bytes
    }

    private fun readLine(input: InputStream): String? {
        val sb = StringBuilder()
        while (true) {
            val c = input.read()
            if (c < 0) return if (sb.isEmpty()) null else sb.toString()
            if (c == '\n'.code) return sb.toString().trimEnd('\r')
            sb.append(c.toChar())
        }
    }

    private fun authorised(header: String?): Boolean {
        if (passwords.isEmpty()) return true
        if (header == null || !header.startsWith("Basic ", ignoreCase = true)) return false
        val decoded = runCatching { String(Base64.getDecoder().decode(header.substring(6).trim()), Charsets.UTF_8) }.getOrNull()
            ?: return false
        val user = decoded.substringBefore(':')
        val password = decoded.substringAfter(':', "")
        return passwords[user] == password
    }

    private fun answer(method: String, path: String, headers: Map<String, String>, body: String): Reply = when (method) {
        "OPTIONS" -> Reply(200, mapOf("Allow" to "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, MOVE"))
        "PROPFIND" -> propfind(path, headers["depth"] ?: "1")
        "GET", "HEAD" -> get(path, headers["if-none-match"], method == "HEAD")
        "PUT" -> put(path, headers, body)
        "MKCOL" -> mkcol(path)
        "MOVE" -> move(path, headers)
        "DELETE" -> delete(path)
        else -> Reply(405, mapOf("Allow" to "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, MOVE"))
    }

    private fun propfind(path: String, depth: String): Reply {
        val isCollection = collections.contains(path)
        val document = documents[path]
        if (!isCollection && document == null) return Reply(404)
        val responses = StringBuilder()
        if (isCollection) {
            responses.append(response(path, null))
            if (depth != "0") {
                val prefix = if (path == "/") "/" else "$path/"
                for (child in collections.filter { it.startsWith(prefix) && it != path && !it.substring(prefix.length).contains('/') }.sorted()) {
                    responses.append(response(child, null))
                }
                for ((childPath, text) in documents.filterKeys { it.startsWith(prefix) && !it.substring(prefix.length).contains('/') }.toSortedMap()) {
                    responses.append(response(childPath, text))
                }
            }
        } else {
            responses.append(response(path, document))
        }
        val xml = "<?xml version=\"1.0\"?><d:multistatus xmlns:d=\"DAV:\" xmlns:s=\"http://sabredav.org/ns\">$responses</d:multistatus>"
        return Reply(207, mapOf("Content-Type" to "application/xml; charset=utf-8"), xml)
    }

    private fun response(path: String, text: String?): String {
        val href = escape(encodePath(path) + if (text == null) "/" else "")
        val props = if (text == null) {
            "<d:resourcetype><d:collection/></d:resourcetype>"
        } else {
            "<d:resourcetype/><d:getetag>${escape(etag(text))}</d:getetag>" +
                "<d:getcontentlength>${text.toByteArray(Charsets.UTF_8).size}</d:getcontentlength>" +
                "<d:getlastmodified>Sat, 27 Sep 2026 12:00:00 GMT</d:getlastmodified>"
        }
        return "<d:response><d:href>$href</d:href><d:propstat><d:prop>$props</d:prop>" +
            "<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"
    }

    private fun get(path: String, ifNoneMatch: String?, head: Boolean): Reply {
        val text = documents[path] ?: return if (collections.contains(path)) Reply(200, mapOf("Content-Type" to "text/html"), "") else Reply(404)
        val tag = etag(text)
        if (ifNoneMatch != null && ifNoneMatch.split(',').map { it.trim() }.any { it == "*" || it == tag }) return Reply(304, mapOf("ETag" to tag))
        return Reply(200, mapOf("Content-Type" to "application/octet-stream", "ETag" to tag), if (head) "" else text)
    }

    private fun put(path: String, headers: Map<String, String>, body: String): Reply {
        if (collections.contains(path)) return Reply(405)
        if (!collections.contains(parentOf(path))) return Reply(409)
        val existing = documents[path]
        val ifNoneMatch = headers["if-none-match"]
        if (ifNoneMatch != null && existing != null && (ifNoneMatch.trim() == "*" || ifNoneMatch.split(',').any { it.trim() == etag(existing) })) return Reply(412)
        val ifMatch = headers["if-match"]
        if (ifMatch != null && (existing == null || ifMatch.split(',').none { it.trim() == "*" || it.trim() == etag(existing) })) return Reply(412)
        documents[path] = body
        return Reply(if (existing == null) 201 else 204, mapOf("ETag" to etag(body)))
    }

    private fun mkcol(path: String): Reply {
        if (collections.contains(path) || documents.containsKey(path)) return Reply(405)
        if (!collections.contains(parentOf(path))) return Reply(409)
        collections.add(path)
        return Reply(201)
    }

    private fun move(path: String, headers: Map<String, String>): Reply {
        val destinationHeader = headers["destination"] ?: return Reply(400)
        val destination = normalise(runCatching { URI(destinationHeader).rawPath }.getOrNull() ?: destinationHeader)
        val text = documents[path]
        if (text == null) return if (collections.contains(path)) Reply(403) else Reply(404)
        if (!collections.contains(parentOf(destination))) return Reply(409)
        val overwrite = (headers["overwrite"] ?: "T").uppercase() != "F"
        val existing = documents[destination]
        if (existing != null && !overwrite) return Reply(412)
        val ifMatch = headers["if-match"]
        if (ifMatch != null && ifMatch.split(',').none { it.trim() == "*" || it.trim() == etag(text) }) return Reply(412)
        documents.remove(path)
        documents[destination] = text
        return Reply(if (existing == null) 201 else 204)
    }

    private fun delete(path: String): Reply {
        if (documents.remove(path) != null) return Reply(204)
        if (!collections.contains(path)) return Reply(404)
        if (path == "/" || path == normalise(root)) return Reply(403)
        val prefix = "$path/"
        collections.removeAll { it == path || it.startsWith(prefix) }
        documents.keys.removeAll { it.startsWith(prefix) }
        return Reply(204)
    }

    private fun mkcolRecursive(path: String) {
        collections.add("/")
        var current = ""
        for (segment in path.split('/').filter { it.isNotEmpty() }) {
            current += "/$segment"
            collections.add(current)
        }
    }

    companion object {
        private const val TAG = "DemoWebDavServer"

        /** `/a/b/` and `/a//b` → `/a/b`, percent-escapes decoded; `/` stays `/`. */
        fun normalise(path: String): String {
            val segments = path.split('/').filter { it.isNotEmpty() }.map { URLDecoder.decode(it, "UTF-8") }
            return if (segments.isEmpty()) "/" else "/" + segments.joinToString("/")
        }

        fun parentOf(path: String): String {
            val slash = path.lastIndexOf('/')
            return if (slash <= 0) "/" else path.substring(0, slash)
        }

        /** A strong ETag from the content (FNV-1a over the UTF-16 code units, as the services' fake computes it). */
        fun etag(text: String): String {
            var hash = 0x811c9dc5L
            for (c in text) {
                hash = hash xor c.code.toLong()
                hash = (hash * 0x01000193L) and 0xffffffffL
            }
            return "\"${hash.toString(16).padStart(8, '0')}-${text.length.toString(16)}\""
        }

        private fun encodePath(path: String): String =
            path.split('/').joinToString("/") { segment -> java.net.URLEncoder.encode(segment, "UTF-8").replace("+", "%20") }

        private fun escape(text: String): String =
            text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")

        private fun reason(status: Int): String = when (status) {
            200 -> "OK"
            201 -> "Created"
            204 -> "No Content"
            207 -> "Multi-Status"
            304 -> "Not Modified"
            400 -> "Bad Request"
            401 -> "Unauthorized"
            403 -> "Forbidden"
            404 -> "Not Found"
            405 -> "Method Not Allowed"
            409 -> "Conflict"
            412 -> "Precondition Failed"
            423 -> "Locked"
            else -> "Status $status"
        }

        private fun ipv4(address: String): ByteArray {
            val parts = address.split('.')
            require(parts.size == 4) { "not a dotted IPv4 address: $address" }
            return ByteArray(4) { parts[it].toInt().toByte() }
        }
    }
}
