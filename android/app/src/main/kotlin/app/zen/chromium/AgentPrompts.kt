package app.zen.chromium

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.cert.X509Certificate
import java.util.Base64

/**
 * The host's side of an AI agent's native prompts (the core's `agentPrompts` capability,
 * `src/android/agentPrompts.ts`): while an agent works a page (`view.interceptAgentPrompts`),
 * the WebView's file chooser, the KeyChain's client-certificate chooser and a download's save
 * dialog are held for the core instead of opening over the page, and the answers come back over
 * the bridge. The shapes of those events and answers live here, pure, so the decisions run on
 * the JVM; [TabWebView], [Security] and [Downloads] carry them out. Nothing an agent answers is
 * remembered for the user: a certificate goes with the one request, a file's bytes with the one
 * chooser. The two-minute default is the core's, and reads as each kind's cancel.
 */
object AgentPrompts {
    /** The `fileChooser` view event for a chooser the page opened (`WebChromeClient.FileChooserParams`). */
    fun fileChooserEvent(requestId: String, multiple: Boolean, acceptTypes: List<String>): JSONObject =
        json(
            "requestId" to requestId,
            "multiple" to multiple,
            "accept" to JSONArray(acceptTypes.map(String::trim).filter(String::isNotEmpty))
        )

    /** One file of a chooser's answer: a path on this device, or bytes the agent sent inline. */
    sealed class UploadFile {
        data class Path(val path: String) : UploadFile()
        data class Inline(val name: String, val mimeType: String?, val base64: String) : UploadFile()
    }

    /** The core's word on a chooser (`view.fileChooserAnswer`). */
    sealed class FileChooserAnswer {
        /** The tab is not an agent's: the system's chooser, as every other tab gets. */
        object User : FileChooserAnswer()
        /** The page hears the chooser was cancelled (the agent's cancel, or the core's default once it waited). */
        object Cancel : FileChooserAnswer()
        data class Files(val files: List<UploadFile>) : FileChooserAnswer()
    }

    /**
     * The answer the bridge carried. A malformed one cancels the chooser: the page must not sit
     * on its callback, and nothing of the system's may open over an agent's page by mistake.
     */
    fun fileChooserAnswer(args: JSONObject): FileChooserAnswer = when (args.str("kind")) {
        "user" -> FileChooserAnswer.User
        "files" -> {
            val files = ArrayList<UploadFile>()
            val list = args.arr("files")
            for (i in 0 until list.length()) {
                val f = list.optJSONObject(i) ?: continue
                val path = f.strOrNull("path")
                val base64 = f.strOrNull("base64")
                when {
                    !path.isNullOrEmpty() -> files.add(UploadFile.Path(path))
                    base64 != null -> files.add(UploadFile.Inline(uploadFileName(f.str("name")), f.strOrNull("mimeType"), base64))
                }
            }
            if (files.isEmpty()) FileChooserAnswer.Cancel else FileChooserAnswer.Files(files)
        }
        else -> FileChooserAnswer.Cancel
    }

    /** The name an inline file is written under: no folders in it, never empty (the page sees it). */
    fun uploadFileName(name: String): String {
        val plain = name.trim().replace('\\', '_').replace('/', '_')
        return if (plain.isEmpty() || plain == "." || plain == "..") "upload" else plain
    }

    /** The core's word on a client-certificate request (`certificate.respond`). */
    sealed class CertificateAnswer {
        /** The tab is not an agent's: the KeyChain chooser, as every other tab gets. */
        object User : CertificateAnswer()
        /** Continue without a certificate (the agent's "none", the default once it waited, or no candidate). */
        object Cancel : CertificateAnswer()
        /** Send the certificate behind this alias, for this request alone. */
        data class Proceed(val alias: String) : CertificateAnswer()
    }

    /**
     * The answer against the aliases the request offered, in the order the event listed them
     * (the core answers with an index into that list). An index that names nothing cancels.
     */
    fun certificateAnswer(args: JSONObject, aliases: List<String>): CertificateAnswer {
        if (args.bool("user")) return CertificateAnswer.User
        if (!args.has("index") || args.isNull("index")) return CertificateAnswer.Cancel
        val index = args.optInt("index", -1)
        return aliases.getOrNull(index)?.let { CertificateAnswer.Proceed(it) } ?: CertificateAnswer.Cancel
    }

    /**
     * A certificate as the core's chooser describes one (`ClientCertificateInfo`); null for a
     * chain with no leaf. The names are the common name, or the organisation when there is none.
     */
    fun describeCertificate(chain: Array<out X509Certificate>?): JSONObject? {
        val leaf = chain?.firstOrNull() ?: return null
        val der = runCatching { leaf.encoded }.getOrNull() ?: return null
        return json(
            "fingerprint" to CertificateExceptions.fingerprintOf(der),
            "subject" to commonNameOf(leaf.subjectX500Principal.name),
            "issuer" to commonNameOf(leaf.issuerX500Principal.name),
            "serialNumber" to (leaf.serialNumber?.toString(16) ?: ""),
            "validFrom" to (leaf.notBefore?.time ?: 0L),
            "validTo" to (leaf.notAfter?.time ?: 0L)
        )
    }

    /**
     * The `CN` of an RFC 2253 distinguished name, else its `O`, else the name whole. Quoted and
     * escaped values are taken as written up to the next unescaped comma.
     */
    fun commonNameOf(dn: String): String {
        val parts = splitDn(dn)
        fun value(key: String): String? =
            parts.firstOrNull { it.first.equals(key, ignoreCase = true) }?.second?.takeIf { it.isNotEmpty() }
        return value("CN") ?: value("O") ?: dn.trim()
    }

    private fun splitDn(dn: String): List<Pair<String, String>> {
        val out = ArrayList<Pair<String, String>>()
        val current = StringBuilder()
        var quoted = false
        var i = 0
        fun flush() {
            val part = current.toString()
            current.setLength(0)
            val eq = part.indexOf('=')
            if (eq > 0) out.add(part.substring(0, eq).trim() to unquote(part.substring(eq + 1).trim()))
        }
        while (i < dn.length) {
            val c = dn[i]
            when {
                c == '\\' && i + 1 < dn.length -> { current.append(c).append(dn[i + 1]); i++ }
                c == '"' -> { quoted = !quoted; current.append(c) }
                (c == ',' || c == ';') && !quoted -> flush()
                else -> current.append(c)
            }
            i++
        }
        flush()
        return out
    }

    private fun unquote(value: String): String {
        val inner = if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value.substring(1, value.length - 1) else value
        val sb = StringBuilder()
        var i = 0
        while (i < inner.length) {
            val c = inner[i]
            if (c == '\\' && i + 1 < inner.length) { sb.append(inner[i + 1]); i++ } else sb.append(c)
            i++
        }
        return sb.toString()
    }

    /**
     * The name a download is written under once its tab's agent answered the ask-where-to-save
     * question: the agent's name when it gave one (a name, no folders – the core checked), else
     * the one the response suggested.
     */
    fun downloadName(agentName: String?, suggested: String): String {
        val name = agentName?.trim()?.replace('\\', '_')?.replace('/', '_') ?: return suggested
        return if (name.isEmpty() || name == "." || name == "..") suggested else name
    }
}

/**
 * The files an agent sends inline for a page's chooser, written under the cache's
 * `agent-uploads` directory (one folder per answer, reached through the `FileProvider` as the
 * camera's photos are, `res/xml/file_paths.xml`) so the WebView reads them as it reads any
 * picked file. The page sees the agent's names. A folder older than [KEEP_MS] at a start was
 * uploaded long ago, or never read, and goes ([sweep]).
 */
object AgentUploads {
    const val DIR = "agent-uploads"
    const val KEEP_MS = 5 * 60 * 60 * 1000L

    /** Write the inline files of one answer into a fresh folder under `dir`; the files in the answer's order. */
    fun write(dir: File, files: List<AgentPrompts.UploadFile.Inline>, now: Long): List<File> {
        val folder = File(dir, "u-$now-${Integer.toHexString(System.identityHashCode(files))}")
        folder.mkdirs()
        return files.map { f ->
            val target = File(folder, AgentPrompts.uploadFileName(f.name))
            target.writeBytes(Base64.getDecoder().decode(f.base64))
            target
        }
    }

    /** Whether a folder in [DIR] is old enough at `now` to go. */
    fun stale(lastModified: Long, now: Long): Boolean = now - lastModified > KEEP_MS

    /** Delete the stale folders in `dir` (which may not exist yet); how many went. */
    fun sweep(dir: File, now: Long): Int {
        var gone = 0
        for (folder in dir.listFiles() ?: return 0) {
            if (!stale(folder.lastModified(), now)) continue
            if (folder.deleteRecursively()) gone++
        }
        return gone
    }
}
