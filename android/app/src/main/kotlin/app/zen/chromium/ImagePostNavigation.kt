package app.zen.chromium

/**
 * The image-search upload's navigation on the phone (CT-32, Chrome's `image_url_post_params`):
 * which of the WebView's two ways a POST into a tab takes. `WebView.postUrl` sends a body as
 * `application/x-www-form-urlencoded` and nothing else (the type is fixed in the WebView's
 * `postUrl`), so an urlencoded engine (Bing's `imageBin`) goes that way with the bytes the core
 * encoded; a multipart engine (Google Lens's `encoded_image` file part) has no POST API of its
 * own and goes as the core's self-submitting form document (`imageUploadFormDoc`): a `<form
 * enctype=multipart/form-data>` whose inline script sets the thumbnail as a `File` and submits
 * before the document's load event, so the submission – a form navigation, which
 * `shouldOverrideUrlLoading` does not see for a POST – replaces the document's own history
 * entry and the WebView frames the multipart body itself. The document is loaded under an
 * opaque origin ([FORM_DOCUMENT_BASE]), never the engine's, so the POST carries `Origin: null`
 * as a browser-initiated POST does and the document can read nothing of the engine's.
 *
 * Pure: [plan] reads the wire and says which; the view acts on it.
 */
object ImagePostNavigation {
    /** The form document's base URL: an opaque origin (null hands the WebView `about:blank`). */
    val FORM_DOCUMENT_BASE: String? = null
    const val FORM_DOCUMENT_MIME = "text/html"
    const val FORM_DOCUMENT_ENCODING = "utf-8"

    sealed class Plan {
        /** `WebView.postUrl(url, body)`: the urlencoded bytes, UTF-8. */
        data class PostUrl(val url: String, val body: ByteArray) : Plan() {
            override fun equals(other: Any?): Boolean =
                other is PostUrl && other.url == url && other.body.contentEquals(body)
            override fun hashCode(): Int = 31 * url.hashCode() + body.contentHashCode()
        }

        /** `loadDataWithBaseURL(FORM_DOCUMENT_BASE, html, …, historyUrl = url)`: the form document. */
        data class FormDocument(val url: String, val html: String) : Plan()

        /** Nothing to post (an empty wire): the address loads by GET, as the desktop without post data would. */
        data class Load(val url: String) : Plan()
    }

    /**
     * The wire's `body` (urlencoded) or `html` (the form document) → the way. A body wins when
     * both are present (the core sends one); an empty or missing pair loads the address.
     */
    fun plan(url: String, body: String?, html: String?): Plan = when {
        !body.isNullOrEmpty() -> Plan.PostUrl(url, body.toByteArray(Charsets.UTF_8))
        !html.isNullOrEmpty() -> Plan.FormDocument(url, html)
        else -> Plan.Load(url)
    }
}
