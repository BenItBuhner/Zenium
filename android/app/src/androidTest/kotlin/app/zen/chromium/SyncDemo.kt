package app.zen.chromium

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.runner.RunWith

/**
 * Records Settings › Sync on the phone end to end (ID-08's UI): the sequence is [SyncDemoBase]'s,
 * with the sync package's capture prefix and the `sync-demo` handshake directory
 * (`android-sync-demo.yml`). Concrete and parameterless, so JUnit sees one constructor; the
 * defaults this class once carried on the base's parameters gave it two and an
 * `initializationError` (#314, found by the nightly sweep #332).
 */
@RunWith(AndroidJUnit4::class)
class SyncDemo : SyncDemoBase("sync-demo-state.json", "services-sync-android-android", "sync-demo") {
    override val tag: String = "SyncDemo"
}
