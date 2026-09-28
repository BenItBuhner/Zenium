package app.zen.chromium

import android.os.Build
import android.webkit.WebSettings
import androidx.webkit.UserAgentMetadata
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature

/**
 * How a tab presents itself to pages: Chrome for Android's reduced user-agent string and its
 * user-agent client hints, every version taken from the installed WebView. WebView's defaults
 * describe an app's embedded view rather than a browser – the string carries a "; wv" marker, a
 * "Version/4.0" token, the Android version, the device model and the OS build number, and the
 * client hints brand the client "Android WebView" – and sites read those as a degraded client
 * (Google refuses to sign in, others serve app-install interstitials or old layouts). Chrome has
 * sent one fixed platform since M110, `Linux; Android 10; K`, with the version reduced to
 * `Chrome/<major>.0.0.0` (`GetUnifiedPlatform` and `BuildUnifiedPlatformUAFromProductAndExtraOs`
 * in components/embedder_support/user_agent_utils.cc), so the device model and the Android version
 * never reach a site through the string; the full version, the OS version and the device model
 * travel in the high-entropy client hints, on a site's request – as Chrome's do.
 * The brand list is Chromium's for a Chromium-branded build (`GenerateBrandVersionList`: a GREASE
 * entry and "Chromium", in the order the major seeds) – the list the desktop sends
 * (`src/shared/browserIdentity.ts`), so a site reads the same brands from both hosts.
 *
 * The pure functions here are unit-tested; [apply] is the WebView glue.
 */
object UserAgent {
    /** A user-agent client hints brand entry (`Sec-CH-UA` / `Sec-CH-UA-Full-Version-List`). */
    data class Brand(val brand: String, val major: String, val full: String)

    /** Chromium's unified platform for Android (`GetUnifiedPlatform`): the same on every phone and tablet. */
    const val UNIFIED_PLATFORM = "Linux; Android 10; K"

    private val BUILD_TOKEN = Regex(" Build/[^;)]*")
    private val WEBVIEW_MARKER = Regex(";\\s*wv\\b")
    private val VERSION_TOKEN = Regex("Version/\\d+(\\.\\d+)* ")
    private val DANGLING_SEPARATOR = Regex(";\\s*\\)")
    private val CHROME_VERSION = Regex("Chrome/(\\d+(?:\\.\\d+){0,3})")
    private val WHITESPACE = Regex("\\s{2,}")
    private val PLATFORM_SECTION = Regex("\\(Linux; Android [^)]*\\)")
    private val MOBILE_TOKEN = Regex(" Mobile Safari/")
    private val RELEASE_NUMBERS = Regex("^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?")

    private val GREASE_CHARS = listOf(" ", "(", ":", "-", ".", "/", ")", ";", "=", "?", "_")
    private val GREASE_VERSIONS = listOf("8", "99", "24")

    /**
     * Chrome's reduced user agent from the WebView's default string: the unified platform, the
     * WebView's Chrome major as `Chrome/<major>.0.0.0`, and `Mobile` where the WebView's own string
     * has it (phones; tablets send none, as Chrome does). Nothing but the major and that token is
     * read from the string, so a WebView that already reduces its own string (`Linux; Android 10;
     * K; wv`, `Chrome/135.0.0.0`) and one that does not come out the same. A WebView naming no
     * Chrome version keeps its string, less the embedded-view markers. Already-reduced strings pass
     * unchanged.
     */
    fun normalize(default: String): String {
        val version = chromeVersion(default) ?: return stripEmbeddedViewMarkers(default)
        return reduced(major(version), mobile = MOBILE_TOKEN.containsMatchIn(default))
    }

    /**
     * `GetReducedUserAgent`: `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like
     * Gecko) Chrome/<major>.0.0.0 Mobile Safari/537.36`, the `Mobile` token only for a phone.
     */
    fun reduced(major: String, mobile: Boolean): String =
        "Mozilla/5.0 ($UNIFIED_PLATFORM) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/$major.0.0.0" +
            (if (mobile) " Mobile" else "") + " Safari/537.36"

    /** The "; wv" marker, the "Version/4.0" token and the OS build number dropped: for a string that names no Chrome version. */
    private fun stripEmbeddedViewMarkers(default: String): String =
        default
            .replace(BUILD_TOKEN, "")
            .replace(WEBVIEW_MARKER, "")
            .replace(VERSION_TOKEN, "")
            .replace(DANGLING_SEPARATOR, ")")
            .replace(WHITESPACE, " ")
            .trim()

    /** The Chrome version a user-agent string reports (`122.0.6261.119`, or `135.0.0.0` once reduced), or null. */
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

    /** A version in the four components the full-version hints carry (`135` → `135.0.0.0`; a full one passes). */
    fun fullVersion(version: String): String {
        val parts = version.split('.').filter { it.isNotEmpty() && it.all(Char::isDigit) }.toMutableList()
        while (parts.size < 4) parts.add("0")
        return parts.take(4).joinToString(".")
    }

    /**
     * Chrome's `Sec-CH-UA-Platform-Version` for an Android release string (`GetPlatformVersion`
     * over `SysInfo::OperatingSystemVersionNumbers`): the leading numbers as `major.minor.bugfix`,
     * the parts the release does not name 0 (`14` → `14.0.0`, `4.4.2` → `4.4.2`), and `0.0.0` for
     * a preview build's codename.
     */
    fun platformVersion(release: String): String {
        val match = RELEASE_NUMBERS.find(release.trim()) ?: return "0.0.0"
        val (major, minor, bugfix) = match.destructured
        return "$major.${minor.ifEmpty { "0" }}.${bugfix.ifEmpty { "0" }}"
    }

    /**
     * Chromium's brand list for a Chromium-branded build (`GenerateBrandVersionList`): a GREASE
     * entry – `Not<c>A<c>Brand`, its characters and its version (8, 99 or 24) picked by the major
     * (`GetGreasedUserAgentBrandVersion`) – and "Chromium" at the WebView's version, the two in
     * the order the major seeds (`GetRandomOrder` for two entries is `{seed % 2, (seed + 1) % 2}`;
     * `shuffled[order[i]] = list[i]`). The list `chromiumBrands` builds on the desktop, entry for
     * entry; no product brand and no "Android WebView".
     */
    fun brands(chromeVersion: String): List<Brand> {
        val major = major(chromeVersion)
        val seed = major.toIntOrNull() ?: 0
        val greaseVersion = GREASE_VERSIONS[seed % GREASE_VERSIONS.size]
        val grease = Brand(
            "Not${GREASE_CHARS[seed % GREASE_CHARS.size]}A${GREASE_CHARS[(seed + 1) % GREASE_CHARS.size]}Brand",
            greaseVersion,
            "$greaseVersion.0.0.0"
        )
        val chromium = Brand("Chromium", major, fullVersion(chromeVersion))
        val list = listOf(grease, chromium)
        val shuffled = arrayOfNulls<Brand>(list.size)
        list.forEachIndexed { i, brand -> shuffled[(seed + i) % list.size] = brand }
        return shuffled.filterNotNull()
    }

    /**
     * Rewrite the user-agent string and, where the WebView supports it, the client hints metadata
     * behind `navigator.userAgentData` and the `Sec-CH-UA-*` headers, to what Chrome for Android
     * sends: the brands above, platform "Android" at the OS's version, the device model as the
     * WebView's default has it (Chrome's `BuildModelInfo()`: the string hides it behind `K`, the
     * high-entropy `Sec-CH-UA-Model` carries it on a site's request), `Mobile` as the string has
     * it, architecture and bitness empty
     * (`GetCpuArchitecture` and `GetCpuBitness` are empty on Android), and the WebView's own full
     * version – read from its default metadata, since a WebView that reduces its minor version
     * names only the major in the string. Desktop site: Chrome-on-Linux's values, as before.
     */
    fun apply(
        settings: WebSettings,
        desktop: Boolean = false,
        default: String = settings.userAgentString,
        osRelease: String = Build.VERSION.RELEASE ?: ""
    ) {
        // `default` is the WebView's own string (captured before the first rewrite), so every
        // switch between the mobile and the desktop shape derives from the same truth.
        val reducedShape = normalize(default)
        settings.userAgentString = if (desktop) desktop(reducedShape) else reducedShape
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.USER_AGENT_METADATA)) return
        val chrome = chromeVersion(default) ?: return
        runCatching {
            val full = webViewFullVersion(settings, chrome)
            val brands = brands(full).map {
                UserAgentMetadata.BrandVersion.Builder()
                    .setBrand(it.brand)
                    .setMajorVersion(it.major)
                    .setFullVersion(it.full)
                    .build()
            }
            val metadata = UserAgentMetadata.Builder().setBrandVersionList(brands).setFullVersion(full)
            if (desktop) {
                // Client hints of a desktop Chrome on Linux (what Chrome for Android sends in
                // desktop mode): platform, its version, the model and mobile-ness change with it.
                metadata.setPlatform("Linux").setPlatformVersion("").setModel("").setMobile(false).setArchitecture("x86").setBitness(64)
            } else {
                // `setModel(null)` keeps the WebView's default – `Build.MODEL`, the model Chrome for
                // Android puts in the high-entropy hint (androidx: null = the system's value).
                metadata.setPlatform("Android").setPlatformVersion(platformVersion(osRelease)).setModel(null)
                    .setMobile(MOBILE_TOKEN.containsMatchIn(default)).setArchitecture("").setBitness(UserAgentMetadata.BITNESS_DEFAULT)
            }
            WebSettingsCompat.setUserAgentMetadata(settings, metadata.build())
        }
    }

    /**
     * The WebView's full version: its own metadata's (`version_info::GetVersionNumber()`, whole even
     * when the string is reduced) when that names the string's major, else the string's token.
     */
    private fun webViewFullVersion(settings: WebSettings, fromUserAgent: String): String {
        val reported = runCatching { WebSettingsCompat.getUserAgentMetadata(settings).fullVersion }.getOrNull()
        return if (reported != null && major(reported) == major(fromUserAgent)) reported else fromUserAgent
    }
}
