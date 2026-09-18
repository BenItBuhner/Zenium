package app.zen.chromium

import android.webkit.WebSettings
import androidx.webkit.UserAgentMetadata
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature

/**
 * How a tab presents itself to pages. WebView's defaults describe an app's embedded view rather than
 * a browser: the user-agent string carries a "; wv" marker, a "Version/4.0" token and the OS build
 * number, and the user-agent client hints brand the client "Android WebView". Sites read those as a
 * degraded client – Google refuses to sign in, others serve app-install interstitials or old layouts
 * – so the tab uses Chrome's shape instead, with every version taken from the installed WebView.
 *
 * The pure functions here are unit-tested; [apply] is the WebView glue.
 */
object UserAgent {
    /** A user-agent client hints brand entry (`Sec-CH-UA` / `Sec-CH-UA-Full-Version-List`). */
    data class Brand(val brand: String, val major: String, val full: String)

    private val BUILD_TOKEN = Regex(" Build/[^;)]*")
    private val WEBVIEW_MARKER = Regex(";\\s*wv\\b")
    private val VERSION_TOKEN = Regex("Version/\\d+(\\.\\d+)* ")
    private val DANGLING_SEPARATOR = Regex(";\\s*\\)")
    private val CHROME_VERSION = Regex("Chrome/(\\d+(?:\\.\\d+){0,3})")
    private val WHITESPACE = Regex("\\s{2,}")

    /**
     * Chrome's user-agent shape with the installed WebView's versions: the "; wv" marker, the
     * "Version/4.0" token and the OS build number go, the platform (Android version, model) and the
     * Chrome version stay as the WebView reports them. Already-normalized strings pass unchanged.
     */
    fun normalize(default: String): String =
        default
            .replace(BUILD_TOKEN, "")
            .replace(WEBVIEW_MARKER, "")
            .replace(VERSION_TOKEN, "")
            .replace(DANGLING_SEPARATOR, ")")
            .replace(WHITESPACE, " ")
            .trim()

    private val PLATFORM_SECTION = Regex("\\(Linux; Android [^)]*\\)")
    private val MOBILE_TOKEN = Regex(" Mobile Safari/")

    /** The full Chrome version a user-agent string reports (`122.0.6261.119`), or null. */
    fun chromeVersion(userAgent: String): String? = CHROME_VERSION.find(userAgent)?.groupValues?.get(1)

    /**
     * Chrome for Android's "Desktop site" user agent: the platform section becomes Linux x86_64
     * and the `Mobile` token goes, so sites serve their desktop pages. Everything else – engine,
     * Chrome version – stays as normalized. Already-desktop strings pass unchanged.
     */
    fun desktop(normalized: String): String =
        normalized
            .replace(PLATFORM_SECTION, "(X11; Linux x86_64)")
            .replace(MOBILE_TOKEN, " Safari/")

    /** Major version of a dotted version string (`122.0.6261.119` → `122`, `0.2.0` → `0`). */
    fun major(version: String): String = version.substringBefore('.')

    /**
     * Brands for the client hints, the way other Chromium browsers declare themselves: the engine as
     * "Chromium" at the WebView's version, the product under its own name (release version only, no
     * pre-release tag), and a GREASE entry so pages keep parsing the list instead of matching it.
     * "Android WebView" is not among them.
     */
    fun brands(chromeVersion: String, productVersion: String): List<Brand> {
        val product = productVersion.substringBefore('-').substringBefore('+')
        return listOf(
            Brand("Chromium", major(chromeVersion), chromeVersion),
            Brand("Zenium", major(product), product),
            Brand("Not;A=Brand", "99", "99.0.0.0")
        )
    }

    /**
     * Rewrite the user-agent string and, where the WebView supports it, the client hints metadata
     * behind `navigator.userAgentData` and the `Sec-CH-UA-*` headers. The platform, its version, the
     * model and the architecture are left to the WebView so they stay truthful.
     */
    fun apply(settings: WebSettings, productVersion: String, desktop: Boolean = false, default: String = settings.userAgentString) {
        // `default` is the WebView's own string (captured before the first rewrite), so every
        // switch between the mobile and the desktop shape derives from the same truth.
        val original = default
        val mobile = normalize(original)
        settings.userAgentString = if (desktop) desktop(mobile) else mobile
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.USER_AGENT_METADATA)) return
        val chrome = chromeVersion(original) ?: return
        val brands = brands(chrome, productVersion).map {
            UserAgentMetadata.BrandVersion.Builder()
                .setBrand(it.brand)
                .setMajorVersion(it.major)
                .setFullVersion(it.full)
                .build()
        }
        runCatching {
            val metadata = UserAgentMetadata.Builder().setBrandVersionList(brands).setFullVersion(chrome)
            if (desktop) {
                // Client hints of a desktop Chrome on Linux (what Chrome for Android sends in
                // desktop mode): platform, its version, the model and mobile-ness change with it.
                metadata.setPlatform("Linux").setPlatformVersion("").setModel("").setMobile(false).setArchitecture("x86").setBitness(64)
            }
            WebSettingsCompat.setUserAgentMetadata(settings, metadata.build())
        }
    }
}
