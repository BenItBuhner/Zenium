package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * A page constructing a `BarcodeDetector` must not kill the app. The WebView binds Chromium's
 * shape-detection service on its in-process GPU thread, and the binding's first act is the Google
 * Play services client's availability check, which reads the HOST app's
 * `com.google.android.gms.version` meta-data: absent, it throws
 * `GooglePlayServicesMissingManifestValueException`, which crosses the JNI boundary uncaught and
 * ends the process before any promise can reject. The manifest carries the value the client
 * compares against (`GOOGLE_PLAY_SERVICES_VERSION_CODE`, 12451000), as a literal - the app has no
 * play-services dependency to take `@integer/google_play_services_version` from - directly under
 * `<application>`, where `PackageManager.getApplicationInfo(..., GET_META_DATA)` reads it. A value
 * moved into an activity, spelled as a resource reference, or given another integer would build
 * fine and crash again (a different integer trips the client's "incorrect manifest value" throw).
 */
class ShapeDetectionManifestTest {
    private companion object {
        const val NAME = "com.google.android.gms.version"
        /** play-services-basement's GOOGLE_PLAY_SERVICES_VERSION_CODE, unchanged since 15.0.0 (2018). */
        const val GOOGLE_PLAY_SERVICES_VERSION_CODE = "12451000"
    }

    private fun read(vararg candidates: String): String {
        val file = candidates.map(::File).firstOrNull { it.exists() }
        assertTrue("${candidates.first()} not found from ${File(".").absolutePath}", file != null)
        return file!!.readText()
    }

    private fun manifest(): String = read("src/main/AndroidManifest.xml", "app/src/main/AndroidManifest.xml")
        .replace(Regex("""<!--[\s\S]*?-->"""), "")

    /** The start tags of `<application>`'s direct children - nested subtrees (activities, services…) skipped. */
    private fun directChildrenOfApplication(manifest: String): List<String> {
        val body = manifest.substringAfter("<application").substringAfter(">").substringBefore("</application>")
        val direct = mutableListOf<String>()
        var depth = 0
        for (tag in Regex("""<(/?)([A-Za-z][\w.-]*)([^>]*?)(/?)>""").findAll(body)) {
            val closing = tag.groupValues[1] == "/"
            val selfClosing = tag.groupValues[4] == "/"
            when {
                closing -> depth--
                selfClosing -> if (depth == 0) direct += tag.value
                else -> {
                    if (depth == 0) direct += tag.value
                    depth++
                }
            }
        }
        assertEquals("unbalanced tags under <application>", 0, depth)
        return direct
    }

    @Test
    fun applicationDeclaresTheGmsVersionOnce() {
        val manifest = manifest()
        val everywhere = Regex("""android:name="${Regex.escape(NAME)}"""").findAll(manifest).count()
        assertEquals("$NAME must be declared exactly once in the manifest", 1, everywhere)
        val declared = directChildrenOfApplication(manifest).filter { """android:name="$NAME"""" in it }
        assertEquals("$NAME must be a direct child of <application>, not of an activity or service", 1, declared.size)
        assertTrue("$NAME must be a <meta-data>", declared.single().startsWith("<meta-data"))
    }

    @Test
    fun theValueIsTheLiteralTheClientComparesAgainst() {
        val declared = directChildrenOfApplication(manifest()).single { """android:name="$NAME"""" in it }
        val value = Regex("""android:value="([^"]*)"""").find(declared)?.groupValues?.get(1)
        assertEquals(
            "$NAME must carry GOOGLE_PLAY_SERVICES_VERSION_CODE as an integer literal (aapt2 stores it " +
                "as the int the client reads with metaData.getInt); a resource reference would need the " +
                "play-services-basement dependency this app does not take",
            GOOGLE_PLAY_SERVICES_VERSION_CODE, value
        )
        assertTrue("android:resource is not what the client reads for this key", "android:resource" !in declared)
    }
}
