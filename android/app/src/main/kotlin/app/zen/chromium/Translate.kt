package app.zen.chromium

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.Collections
import java.util.concurrent.CancellationException
import java.util.concurrent.Executors

/**
 * The Android half of offline page translation: the model files. The core (in the chrome WebView)
 * decides which files it needs and where they come from; this class fetches them into
 * `files/translate/`, checks the size and SHA-256 the registry promised, and keeps the directory
 * an inventory of complete files only. The engine worker reads them back through the chrome's
 * asset loader (`ChromeWebView` maps `/translate/` to the same directory), so model bytes never
 * cross the JS bridge.
 */
class Translate(context: Context, private val host: Host) {
    private val dir = modelsDir(context)
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newFixedThreadPool(2) { r -> Thread(r, "zen-translate") }
    private val cancelled: MutableSet<String> = Collections.synchronizedSet(HashSet())

    /** Names and sizes of the stored files (partial downloads excluded). */
    fun list(reply: (Any?) -> Unit) {
        io.execute {
            val out = JSONArray()
            dir.mkdirs()
            dir.listFiles()?.forEach { file ->
                if (file.isFile && SAFE_NAME.matches(file.name) && !file.name.endsWith(".part"))
                    out.put(json("name" to file.name, "size" to file.length()))
            }
            main.post { reply(out) }
        }
    }

    fun download(token: String, url: String, name: String, size: Long, sha256: String, reply: (Any?) -> Unit) {
        io.execute {
            val result = runCatching { fetch(token, url, name, size, sha256) }
            main.post {
                result.fold(
                    { reply(json("ok" to true)) },
                    { e ->
                        val wasCancelled = e is CancellationException
                        reply(json("ok" to false, "cancelled" to wasCancelled, "error" to (e.message ?: e.javaClass.simpleName)))
                    }
                )
            }
        }
    }

    fun cancel(token: String) {
        cancelled.add(token)
    }

    fun delete(names: JSONArray, reply: (Any?) -> Unit) {
        io.execute {
            for (i in 0 until names.length()) {
                val name = names.optString(i)
                if (SAFE_NAME.matches(name)) File(dir, name).delete()
            }
            main.post { reply(null) }
        }
    }

    fun shutdown() {
        io.shutdownNow()
    }

    private fun fetch(token: String, url: String, name: String, size: Long, sha256: String) {
        if (!SAFE_NAME.matches(name)) throw IOException("refusing to store $name")
        dir.mkdirs()
        val file = File(dir, name)
        val partial = File(dir, "$name.part")
        try {
            val connection = open(url)
            val status = connection.responseCode
            if (status !in 200..299) throw IOException("the model download failed (HTTP $status)")
            val digest = MessageDigest.getInstance("SHA-256")
            var lastReport = 0L
            var received = 0L
            connection.inputStream.use { input ->
                FileOutputStream(partial).use { out ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        if (cancelled.contains(token)) throw CancellationException("cancelled")
                        val n = input.read(buffer)
                        if (n < 0) break
                        out.write(buffer, 0, n)
                        digest.update(buffer, 0, n)
                        received += n
                        if (received > size) throw IOException("the model file is larger than the registry states")
                        val now = SystemClock.elapsedRealtime()
                        if (now - lastReport >= 250) {
                            lastReport = now
                            report(token, received)
                        }
                    }
                }
            }
            if (received != size) throw IOException("the model file is $received bytes, the registry lists $size")
            val hex = digest.digest().joinToString("") { "%02x".format(it) }
            if (!hex.equals(sha256, ignoreCase = true)) throw IOException("the model file is corrupt (checksum mismatch)")
            file.delete()
            if (!partial.renameTo(file)) throw IOException("could not store the model file")
        } catch (e: Exception) {
            partial.delete()
            throw e
        } finally {
            cancelled.remove(token)
        }
    }

    /** The registry's CDN answers directly; follow a few redirects anyway (https only). */
    private fun open(url: String): HttpURLConnection {
        var current = URL(url)
        for (hop in 0 until 6) {
            if (current.protocol != "https") throw IOException("refusing a non-https model download")
            val connection = (current.openConnection() as HttpURLConnection).apply {
                connectTimeout = 15_000
                readTimeout = 30_000
                instanceFollowRedirects = false
                setRequestProperty("Accept", "application/octet-stream")
            }
            val status = connection.responseCode
            if (status in 300..399) {
                val location = connection.getHeaderField("Location") ?: throw IOException("redirect without a location")
                connection.disconnect()
                current = URL(current, location)
                continue
            }
            return connection
        }
        throw IOException("too many redirects")
    }

    private fun report(token: String, received: Long) {
        main.post { host.chrome.hostEvent("translate.progress", json("token" to token, "received" to received)) }
    }

    companion object {
        /** Under `filesDir`; `ChromeWebView` serves the same directory at `/translate/`. */
        const val MODELS_DIR = "translate"

        /** Only names the core's model manager produces (`<from>_<to>_<version>_<type>.<ext>`). */
        val SAFE_NAME = Regex("^[A-Za-z0-9][A-Za-z0-9._-]*$")

        fun modelsDir(context: Context): File = File(context.filesDir, MODELS_DIR).apply { mkdirs() }
    }
}
