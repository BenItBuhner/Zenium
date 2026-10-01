package app.zen.chromium

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.Principal
import java.security.cert.X509Certificate
import java.util.Base64
import javax.security.auth.x500.X500Principal

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

    /**
     * One file of a chooser's answer: the bytes the agent sent inline, under the name the page
     * will see. Never a path: a file the WebView opened by path would be read as this app – its
     * cookies, its preferences, the agent token store – and handed to whatever page the agent
     * drives, so no path an agent names is ever turned into a `Uri` here.
     */
    data class UploadFile(val name: String, val mimeType: String?, val base64: String)

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
     * on its callback, and nothing of the system's may open over an agent's page by mistake. An
     * answer with a path in it is refused whole, not thinned to its inline files: the core
     * already refused it and told the agent (`agentPrompts.ts`), and this side must not differ
     * on what crosses the app's sandbox.
     */
    fun fileChooserAnswer(args: JSONObject): FileChooserAnswer = when (args.str("kind")) {
        "user" -> FileChooserAnswer.User
        "files" -> {
            val files = ArrayList<UploadFile>()
            val list = args.arr("files")
            var refused = false
            for (i in 0 until list.length()) {
                val f = list.optJSONObject(i) ?: continue
                if (f.has("path")) refused = true
                val base64 = f.strOrNull("base64") ?: continue
                files.add(UploadFile(uploadFileName(f.str("name")), f.strOrNull("mimeType"), base64))
            }
            if (refused || files.isEmpty()) FileChooserAnswer.Cancel else FileChooserAnswer.Files(files)
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
     * The aliases an agent's request for `host` may be offered, out of the picks the user made
     * this session (`host:port` → alias): those for the same host, on any port, and no other. A
     * certificate the user showed one site is their consent for that site; an agent on another
     * host never sees it, whatever the KeyChain would have let the user pick there.
     */
    fun candidateAliases(choices: Map<String, String>, host: String): List<String> =
        choices.entries
            .filter { (key, _) -> key.substringBeforeLast(':').equals(host, ignoreCase = true) }
            .map { it.value }
            .distinct()

    /**
     * Whether a chain answers what the server asked for, as `KeyChain.choosePrivateKeyAlias`
     * narrows the user's list by the same two facts: the leaf's key algorithm is among
     * `keyTypes`, and one of the chain's issuers – or the leaf itself – is among the accepted
     * `issuers` (canonical distinguished names). An empty list on either side asks nothing.
     */
    fun certificateFits(leafKeyAlgorithm: String, chainNames: List<String>, keyTypes: List<String>, issuers: List<String>): Boolean {
        val keyOk = keyTypes.isEmpty() || keyTypes.any { it.equals(leafKeyAlgorithm, ignoreCase = true) }
        val issuerOk = issuers.isEmpty() || chainNames.any { name -> issuers.any { it == name } }
        return keyOk && issuerOk
    }

    /** [certificateFits] for a chain as the KeyChain returns it, against the request's facts. */
    fun certificateFits(chain: Array<out X509Certificate>, keyTypes: Array<String>?, principals: Array<out Principal>?): Boolean {
        val leaf = chain.firstOrNull() ?: return false
        val names = chain.flatMap { listOf(it.subjectX500Principal, it.issuerX500Principal) }
            .map { it.getName(X500Principal.CANONICAL) }
        // A principal that is no distinguished name stays as written, and so matches no chain.
        val issuers = principals.orEmpty().map { p ->
            (p as? X500Principal ?: runCatching { X500Principal(p.name) }.getOrNull())?.getName(X500Principal.CANONICAL) ?: p.name
        }
        return certificateFits(leaf.publicKey.algorithm, names, keyTypes.orEmpty().toList(), issuers)
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
     * question: the agent's name when it gave one, taken the way every download's name is
     * ([DownloadLogic.filenameFor]: sanitised – no folders, no control characters, no leading
     * dot, no reserved name, within the length cap – and given the type's extension when it has
     * none), else the one the response suggested. The core checked for folders; the rest is this
     * side's, since the name goes to MediaStore and the documents provider as is.
     */
    fun downloadName(agentName: String?, suggested: String, mimeType: String, extensionFor: (String) -> String?): String {
        val clean = agentName?.let(DownloadLogic::sanitizeFilename)
        if (clean.isNullOrEmpty()) return suggested
        return DownloadLogic.filenameFor("", null, mimeType.ifEmpty { null }, extensionFor, suggestedName = clean)
    }
}

/**
 * The files an agent sends inline for a page's chooser, written under the cache's
 * `agent-uploads` directory (one folder per answer, reached through the `FileProvider` as the
 * camera's photos are, `res/xml/file_paths.xml`) so the WebView reads them as it reads any
 * picked file. The page sees the agent's names: each file sits in its own numbered folder, so
 * two files of one answer under the same name stay two files. The folders of a tab's answers
 * go when its agent lets the page go ([TabWebView.setInterceptAgentPrompts]), the page reading
 * them at submit time until then; one older than [KEEP_MS] at a start, or at a later answer,
 * was left by a run that ended first and goes too ([sweep]).
 */
object AgentUploads {
    const val DIR = "agent-uploads"
    const val KEEP_MS = 5 * 60 * 60 * 1000L

    /** One answer's folder under [DIR] and its files, in the answer's order. */
    class Written(val folder: File, val files: List<File>)

    /** Write the inline files of one answer into a fresh folder under `dir`, each in a numbered folder of its own. */
    fun write(dir: File, files: List<AgentPrompts.UploadFile>, now: Long): Written {
        val folder = File(dir, "u-$now-${Integer.toHexString(System.identityHashCode(files))}")
        val written = files.mapIndexed { i, f ->
            val own = File(folder, i.toString()).apply { mkdirs() }
            val target = File(own, AgentPrompts.uploadFileName(f.name))
            target.writeBytes(Base64.getDecoder().decode(f.base64))
            target
        }
        return Written(folder, written)
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
