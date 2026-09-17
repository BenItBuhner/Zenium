package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Browsing data must not leave the device through Auto Backup or device-to-device transfer: the
 * manifest turns backup off and points at rules that exclude every location an app can hold data
 * in, for the releases that read either file (API 26 to 30, and 31+). A rule file that names the
 * domains but misses one, or a manifest that stops referencing it, would silently re-enable the
 * upload of cookies, storage, downloads metadata and the agent token.
 */
class BackupRulesTest {
    private val domains = setOf(
        "root", "file", "database", "sharedpref", "external",
        "device_root", "device_file", "device_database", "device_sharedpref"
    )

    private fun read(vararg candidates: String): String {
        val file = candidates.map(::File).firstOrNull { it.exists() }
        assertTrue("${candidates.first()} not found from ${File(".").absolutePath}", file != null)
        return file!!.readText()
    }

    private fun excludedDomains(section: String): Set<String> =
        Regex("""<exclude domain="([a-z_]+)" path="\." />""").findAll(section).map { it.groupValues[1] }.toSet()

    @Test
    fun manifestDisablesBackupAndDeclaresBothRuleFiles() {
        val manifest = read("src/main/AndroidManifest.xml", "app/src/main/AndroidManifest.xml")
        val application = manifest.substringAfter("<application").substringBefore(">")
        assertTrue("allowBackup must be false", """android:allowBackup="false"""" in application)
        assertTrue(
            "API 26-30 rules missing",
            """android:fullBackupContent="@xml/zenium_backup_rules"""" in application
        )
        assertTrue(
            "API 31+ rules missing",
            """android:dataExtractionRules="@xml/zenium_data_extraction_rules"""" in application
        )
    }

    @Test
    fun legacyRulesExcludeEveryDomain() {
        val rules = read("src/main/res/xml/zenium_backup_rules.xml", "app/src/main/res/xml/zenium_backup_rules.xml")
        val content = rules.substringAfter("<full-backup-content>").substringBefore("</full-backup-content>")
        assertEquals(domains, excludedDomains(content))
        assertTrue("nothing may be included", "<include" !in content)
    }

    @Test
    fun extractionRulesExcludeEveryDomainFromCloudBackupAndDeviceTransfer() {
        val rules = read(
            "src/main/res/xml/zenium_data_extraction_rules.xml",
            "app/src/main/res/xml/zenium_data_extraction_rules.xml"
        )
        val cloud = rules.substringAfter("<cloud-backup").substringBefore("</cloud-backup>")
        val transfer = rules.substringAfter("<device-transfer>").substringBefore("</device-transfer>")
        assertTrue("unencrypted cloud backup must be refused", """disableIfNoEncryptionCapabilities="true"""" in cloud)
        assertEquals(domains, excludedDomains(cloud))
        assertEquals(domains, excludedDomains(transfer))
        assertTrue("nothing may be included", "<include" !in rules)
    }
}
