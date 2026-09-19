package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The host's side of private browsing beyond the profile: the window's screenshot guard goes up
 * exactly while the chrome says the surface is private (a recording is let in only when asked,
 * which [PrivateBrowsing.guard] allows in debug builds alone), and the launcher's static shortcut
 * reaches `MainActivity` with the action the activity turns into a private tab. The resource
 * wiring is checked from the files: a shortcut whose meta-data, id, action or target drifted
 * would install and never open anything.
 */
class PrivateBrowsingTest {
    private fun read(vararg candidates: String): String {
        val file = candidates.map(::File).firstOrNull { it.exists() }
        assertTrue("${candidates.first()} not found from ${File(".").absolutePath}", file != null)
        return file!!.readText()
    }

    @Test
    fun theGuardGoesUpOnThePrivateSurfaceAloneAndARecordingTakesItDown() {
        assertTrue(PrivateBrowsing.guardWanted(privateSurface = true, recording = false))
        assertFalse(PrivateBrowsing.guardWanted(privateSurface = false, recording = false))
        assertFalse(PrivateBrowsing.guardWanted(privateSurface = true, recording = true))
        assertFalse(PrivateBrowsing.guardWanted(privateSurface = false, recording = true))
        // The override is off until a recording driver turns it on.
        assertFalse(PrivateBrowsing.captureForRecording)
    }

    @Test
    fun theShortcutOpensAPrivateTabInTheBrowserActivity() {
        val shortcuts = read("src/main/res/xml/shortcuts.xml", "app/src/main/res/xml/shortcuts.xml")
        val shortcut = shortcuts.substringAfter("<shortcut").substringBefore("</shortcut>")
        assertTrue("""android:shortcutId="${PrivateBrowsing.SHORTCUT_ID}"""" in shortcut)
        assertTrue("""android:enabled="true"""" in shortcut)
        assertTrue("""android:action="${PrivateBrowsing.ACTION_NEW_TAB}"""" in shortcut)
        assertTrue("""android:targetClass="app.zen.chromium.MainActivity"""" in shortcut)
        // The target package is the build's applicationId (debug carries a suffix), through the
        // resource the build script writes for every variant.
        assertTrue("""android:targetPackage="@string/application_id"""" in shortcut)
        val build = read("build.gradle.kts", "app/build.gradle.kts")
        assertTrue("""makeResValueKey("string", "application_id")""" in build)
        // One shortcut: the launcher shows the app's own before any pinned web app.
        assertEquals(1, shortcuts.split("<shortcut ").size - 1)
    }

    @Test
    fun theShortcutsLabelsAndIconExist() {
        val shortcuts = read("src/main/res/xml/shortcuts.xml", "app/src/main/res/xml/shortcuts.xml")
        val strings = read("src/main/res/values/strings.xml", "app/src/main/res/values/strings.xml")
        for (name in listOf("shortcut_private_short", "shortcut_private_long")) {
            assertTrue("$name unused", """@string/$name"""" in shortcuts)
            assertTrue("$name undefined", """<string name="$name">""" in strings)
        }
        assertTrue("""<string name="shortcut_private_short">New private tab</string>""" in strings)
        assertTrue("""android:icon="@drawable/ic_shortcut_private"""" in shortcuts)
        val icon = read(
            "src/main/res/drawable/ic_shortcut_private.xml",
            "app/src/main/res/drawable/ic_shortcut_private.xml"
        )
        assertTrue("<adaptive-icon" in icon)
        assertTrue("@drawable/ic_shortcut_private_foreground" in icon)
        assertTrue("@color/shortcut_private_background" in icon)
    }

    @Test
    fun everyLauncherAliasDeclaresTheShortcuts() {
        val manifest = read("src/main/AndroidManifest.xml", "app/src/main/AndroidManifest.xml")
        val meta = """<meta-data android:name="android.app.shortcuts" android:resource="@xml/shortcuts" />"""
        val aliases = manifest.split("<activity-alias").drop(1)
        assertEquals(LauncherIconVariants.ALIASES.size, aliases.size)
        for (alias in aliases) {
            val body = alias.substringBefore("</activity-alias>")
            assertTrue("an alias without the shortcuts: ${body.lines().first()}", meta in body)
            assertTrue("android.intent.category.LAUNCHER" in body)
        }
        // The browser activity itself holds no launcher entry, so the meta-data would be dead there.
        val activity = manifest.substringAfter("android:name=\".MainActivity\"").substringBefore("</activity>")
        assertFalse("android.app.shortcuts" in activity)
    }
}
