package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * A link no app can open (W6-D2, services' ruling on #538's divergence): the custom tab REFUSES
 * it – nothing started – and runs the deliberate fallback in the browser window's order, the
 * core's `noHandler` (`src/core/externalProtocols.ts`): the `intent://`'s `S.browser_fallback_url`
 * loaded in the tab; else the store listing of the package it names; else the toast. The order
 * is a pure plan ([ExternalProtocols.Fallback]) run here; the engine's and the host's wiring is
 * read from the sources, as `CustomTabOpenInAppPromptTest` reads the confirmation's (the Android
 * classes the engine starts are stubs on the JVM). The browser window's path is pinned unchanged:
 * its core answers `false` and runs its own fallback, and the engine's refusal starts nothing.
 * The store step names a package only when the core's `intentPackage` would (W6-D4, #554's nit):
 * a malformed one falls through to the toast as a missing one does; the web address wins over both.
 */
class ExternalProtocolsNoHandlerTest {
    private val root = repoRoot()
    private val engine = File(root, "android/app/src/main/kotlin/app/zen/chromium/ExternalProtocols.kt").readText()
    private val host = File(root, "android/app/src/main/kotlin/app/zen/chromium/CustomTabHost.kt").readText()
    private val core = File(root, "src/core/externalProtocols.ts").readText()
    private val shared = File(root, "src/shared/externalProtocols.ts").readText()

    /** The fallback's order: the web address first, the store listing for a package without one, the toast for neither. */
    @Test
    fun theFallbackRunsInTheBrowserWindowsOrder() {
        assertEquals(
            "an intent:// with a web fallback loads it in the tab",
            ExternalProtocols.Fallback.LoadInTab("https://example.com/get-the-app"),
            ExternalProtocols.Fallback.of("https://example.com/get-the-app", null)
        )
        assertEquals(
            "the web fallback wins over the package's store listing",
            ExternalProtocols.Fallback.LoadInTab("http://127.0.0.1:8137/fallback.html"),
            ExternalProtocols.Fallback.of("http://127.0.0.1:8137/fallback.html", "com.example.app")
        )
        assertEquals(
            "a package without a web fallback: its store listing, as Chrome opens it",
            ExternalProtocols.Fallback.StoreListing("market://details?id=com.example.app"),
            ExternalProtocols.Fallback.of(null, "com.example.app")
        )
        assertEquals("neither: the word", ExternalProtocols.Fallback.Toast, ExternalProtocols.Fallback.of(null, null))
        assertEquals("No app can open this link", ExternalProtocols.NO_APP_TOAST)
    }

    /** A package the core's `intentPackage` would not read yields no store listing: the plan falls through to the toast exactly as a missing package does. */
    @Test
    fun aPackageTheCoreWouldNotNameYieldsNoStoreListing() {
        val malformed = listOf(
            "com.evil/../x",
            "com.example app",
            "https://play.google.com/store/apps/details?id=com.example.app",
            "",
            "com.example.app;end"
        )
        for (pkg in malformed) {
            assertEquals(
                "`$pkg` is no package to the core, so the plan is the toast, as for no package at all",
                ExternalProtocols.Fallback.of(null, null),
                ExternalProtocols.Fallback.of(null, pkg)
            )
        }
    }

    /** A well-formed package still yields its listing with the package verbatim – well-formed by the core's rule, read from the shared source, which the engine quotes and applies. */
    @Test
    fun aWellFormedPackageYieldsItsListingVerbatimByTheCoresRule() {
        assertEquals(
            ExternalProtocols.Fallback.StoreListing("market://details?id=com.example.app"),
            ExternalProtocols.Fallback.of(null, "com.example.app")
        )
        assertEquals(
            ExternalProtocols.Fallback.StoreListing("market://details?id=a_b.c1"),
            ExternalProtocols.Fallback.of(null, "a_b.c1")
        )
        // The core's regex, verbatim from `intentPackage`, is quoted in the engine and its class is the engine's check.
        val intentPackage = shared.substring(shared.indexOf("export function intentPackage(").also { assertTrue("the shared source has intentPackage", it >= 0) })
        val coreRegex = Regex("""const match = (/\S+/)\.exec\(url\)""").find(intentPackage)?.groupValues?.get(1) ?: error("intentPackage has no regex to read")
        assertTrue("the core's regex is quoted verbatim in the engine", engine.contains(coreRegex))
        val coreClass = Regex("""package=\(\[([^\]]+)\]\+\)""").find(coreRegex)?.groupValues?.get(1) ?: error("the core's regex has no package class to read")
        assertTrue("the engine's check is the core's class, whole-token", engine.contains("val PACKAGE = Regex(\"[$coreClass]+\")"))
        val body = body(engine, "fun of(fallbackUrl: String?, pkg: String?): Fallback")
        assertTrue("the check guards the store step", body.contains("pkg != null && PACKAGE.matches(pkg) -> StoreListing(\"market://details?id=\$pkg\")"))
        // The plan names a package exactly when the core would: the same samples through the core's regex, whole-token.
        val core = Regex("[$coreClass]+")
        val samples = listOf("com.example.app", "a_b.c1", "a", "com.evil/../x", "com.example app", "https://play.google.com/store/apps/details?id=com.example.app", "", "com.example.app;end", "com.example.app#Intent", "com.example.app?x=1", "com.example.app&y=2", "com-example")
        for (pkg in samples) {
            val listing = ExternalProtocols.Fallback.of(null, pkg) is ExternalProtocols.Fallback.StoreListing
            assertEquals("`$pkg`: a listing exactly when the core would name the package", core.matches(pkg), listing)
        }
    }

    /** The web address still wins, over a malformed package as over a well-formed one: the check stands behind the URL, never ahead of it. */
    @Test
    fun theWebFallbackWinsOverAMalformedPackageToo() {
        assertEquals(
            ExternalProtocols.Fallback.LoadInTab("https://example.com/get-the-app"),
            ExternalProtocols.Fallback.of("https://example.com/get-the-app", "com.evil/../x")
        )
        assertEquals(
            ExternalProtocols.Fallback.LoadInTab("http://127.0.0.1:8149/fallback.html"),
            ExternalProtocols.Fallback.of("http://127.0.0.1:8149/fallback.html", "")
        )
    }

    /** The engine runs the plan in that order, and the core's `noHandler` reads the same three steps from the same URL. */
    @Test
    fun theEngineAndTheCoreRunTheSameThreeSteps() {
        val fallback = body(engine, "private fun fallback(p: Pending)")
        assertTrue("the plan is made from the intent's web fallback and its package", fallback.contains("Fallback.of(p.fallbackUrl, p.intent?.`package`)"))
        assertTrue("the web address loads in the tab that asked", fallback.contains("is Fallback.LoadInTab -> p.tab.loadUrl(plan.url)"))
        assertTrue("the store listing is started as a new task", fallback.contains("is Fallback.StoreListing -> {") && fallback.contains("Intent(Intent.ACTION_VIEW, Uri.parse(plan.uri)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)"))
        assertTrue("no store either: the toast", fallback.contains("catch (e: ActivityNotFoundException) {") && Regex("""ActivityNotFoundException\) \{[\s\S]*?toastNoApp\(\)""").containsMatchIn(fallback))
        assertTrue("neither a web address nor a package: the toast", fallback.contains("Fallback.Toast -> toastNoApp()"))
        assertTrue("a window on its way out shows nothing", fallback.trimStart().startsWith("if (host.activity.isFinishing || host.activity.isDestroyed) return"))
        assertTrue("the word is the core's", engine.contains("const val NO_APP_TOAST = \"No app can open this link\"") && core.contains("this.browser.toast('No app can open this link', 'info', win)"))
        // The core's order: the fallback URL, else the package's listing, else the toast.
        val noHandler = Regex("""private noHandler\(request: HostExternalRequest, win: ZenWindow\): void \{([\s\S]*?)\n  \}""").find(core)?.groupValues?.get(1) ?: error("the core has no noHandler")
        assertTrue(noHandler.indexOf("intentFallbackUrl(request.url)") < noHandler.indexOf("intentPackage(request.url)"))
        assertTrue(noHandler.indexOf("intentPackage(request.url)") < noHandler.indexOf("this.browser.toast('No app can open this link'"))
        assertTrue("the fallback the engine reads is the one the core reads", engine.contains("const val EXTRA_FALLBACK_URL = \"browser_fallback_url\"") && File(root, "src/shared/externalProtocols.ts").readText().contains("S\\.browser_fallback_url="))
    }

    /** `refuseWithFallback` takes the request off the ledger, starts nothing, remembers no declined site and runs the fallback. */
    @Test
    fun aRefusalWithFallbackStartsNothingAndRemembersNoSite() {
        val refuse = body(engine, "fun refuseWithFallback(requestId: String)")
        assertEquals(
            "the pending request is removed and the fallback runs; nothing else",
            listOf("val p = pending.remove(requestId) ?: return", "fallback(p)"),
            refuse.lines().map(String::trim).filter(String::isNotEmpty)
        )
        assertFalse("no app was declined, so no site is remembered as having declined one", refuse.contains("declinedAppHosts"))
        assertFalse("nothing is started for the request itself", refuse.contains("startActivity"))
        assertTrue("it is public: the custom tab's host calls it", Regex("""\n    fun refuseWithFallback\(requestId: String\)""").containsMatchIn(engine))
    }

    /** `respond(true)` for an address that parsed to no intent runs the fallback instead of returning without a word. */
    @Test
    fun anAddressThatParsedToNoIntentDoesNotVanish() {
        val respond = body(engine, "fun respond(requestId: String, allow: Boolean)")
        assertTrue(respond.contains("val intent = p.intent ?: run { fallback(p); return }"))
        assertFalse("the silent path is gone", Regex("""p\.intent \?: return\b""").containsMatchIn(respond))
    }

    /** The browser window's path is untouched: its core answers `false` and runs its own fallback; the engine's refusal starts nothing and runs none. */
    @Test
    fun theBrowserWindowsPathIsTheCores() {
        assertTrue(
            "the core refuses a link no app can open and runs noHandler",
            Regex("""if \(request\.handler === 'none'\) \{\s*this\.answer\(request\.requestId, false\)\s*this\.noHandler\(request, win\)\s*return\s*\}""").containsMatchIn(core)
        )
        val respond = body(engine, "fun respond(requestId: String, allow: Boolean)")
        assertTrue(
            "a refusal from the core remembers a declined App Link site and does nothing else – the core's fallback is the core's",
            Regex("""if \(!allow\) \{\s*p\.appHost\?\.let\(declinedAppHosts::add\)\s*return\s*\}""").containsMatchIn(respond)
        )
        assertFalse("the engine runs no fallback of its own on a refusal", Regex("""if \(!allow\) \{[^}]*fallback""").containsMatchIn(respond))
    }

    /** The custom tab's host: a finishing window answers `false` first; then a link no app can open is refused with the fallback, never let through. */
    @Test
    fun theCustomTabRefusesALinkNoAppCanOpenWithTheFallback() {
        val ask = body(host, "private fun askExternal(args: JSONObject)")
        val finishing = ask.indexOf("if (activity.isFinishing || activity.isDestroyed) {\n            externalProtocols.respond(requestId, false)")
        val none = ask.indexOf("if (args.str(\"handler\") == \"none\") {\n            externalProtocols.refuseWithFallback(requestId)\n            return\n        }")
        assertTrue("a window on its way out answers false before anything", finishing >= 0)
        assertTrue("a link no app can open is refused and the fallback runs", none >= 0)
        assertTrue("the finishing guard comes first", finishing < none)
        assertFalse("nothing goes through unasked any more", ask.contains("externalProtocols.respond(requestId, true)"))
        assertTrue("every other request is asked on the sheet", ask.contains("NativePromptSheet("))
    }

    private fun body(source: String, signature: String): String {
        val start = source.indexOf(signature).takeIf { it >= 0 } ?: error("no `$signature` in the source")
        val open = source.indexOf('{', start + signature.length)
        var depth = 0
        for (i in open until source.length) {
            when (source[i]) {
                '{' -> depth++
                '}' -> if (--depth == 0) return source.substring(open + 1, i)
            }
        }
        error("`$signature` never closes")
    }

    private companion object {
        fun repoRoot(): File {
            var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
            while (dir != null) {
                if (File(dir, "package.json").isFile && File(dir, "android").isDirectory) return dir
                dir = dir.parentFile
            }
            error("not inside the repository")
        }
    }
}
