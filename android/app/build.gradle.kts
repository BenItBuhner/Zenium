import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The chrome (React + browser core) is built by Vite from the repository root. Gradle runs that
// build before packaging unless `-PskipWeb` is given (the npm scripts pass it after building).
val webRoot = rootProject.projectDir.parentFile
val skipWeb = project.hasProperty("skipWeb")
val buildWeb = tasks.register<Exec>("buildWeb") {
    group = "build"
    description = "Builds the Zenium chrome and page script into app/src/main/assets"
    workingDir = webRoot
    val npm = if (System.getProperty("os.name").lowercase().contains("win")) "npm.cmd" else "npm"
    commandLine(npm, "run", "build:android:web")
    inputs.dir(webRoot.resolve("src"))
    outputs.dir(projectDir.resolve("src/main/assets/www"))
    outputs.file(projectDir.resolve("src/main/assets/page.js"))
    outputs.file(projectDir.resolve("src/main/assets/ext.js"))
    outputs.file(projectDir.resolve("src/main/assets/ext-janitor.js"))
    onlyIf { !skipWeb }
}

// The bundled snapshot of the default filter lists (resources/blocking, refreshed with
// `npm run blocking:snapshot`) ships as assets so the first run blocks ads before any download.
// The asset merger inflates the `.txt.gz` files and drops the extension on the way into the APK;
// `Blocking.readBundledText` opens them by either name.
val copyBlockingSnapshot = tasks.register<Copy>("copyBlockingSnapshot") {
    group = "build"
    description = "Copies the bundled filter-list snapshot into app/src/main/assets/blocking"
    from(webRoot.resolve("resources/blocking"))
    into(projectDir.resolve("src/main/assets/blocking"))
}

// The bundled snapshot of the Safe Browsing feeds (resources/safebrowsing, refreshed with
// `npm run safebrowsing:snapshot`): one prefix-table document per feed, seeded into the profile
// by the core on first run and read by the Kotlin guard (privacy/Privacy.kt, `bundledFeed`).
val copySafeBrowsingSnapshot = tasks.register<Copy>("copySafeBrowsingSnapshot") {
    group = "build"
    description = "Copies the bundled Safe Browsing snapshot into app/src/main/assets/safebrowsing"
    from(webRoot.resolve("resources/safebrowsing"))
    into(projectDir.resolve("src/main/assets/safebrowsing"))
}

val versionProps = Properties().apply {
    // Mirror the npm package version so About shows the same number on every platform.
    val pkg = webRoot.resolve("package.json").readText()
    val match = Regex("\"version\"\\s*:\\s*\"([^\"]+)\"").find(pkg)
    setProperty("version", match?.groupValues?.get(1) ?: "0.0.0")
}
val appVersion: String = versionProps.getProperty("version")

/**
 * Android installs only upgrade when the integer versionCode grows, so derive it from the semver
 * in package.json instead of bumping it by hand:
 *
 *     major * 1_000_000 + minor * 10_000 + patch * 100 + channel
 *
 * `channel` orders pre-releases below the final build of the same version: alpha.N → N,
 * beta.N → 30 + N, rc.N → 60 + N, any other pre-release → 90 + N, final release → 99.
 * `-PversionCode=…` or ZEN_ANDROID_VERSION_CODE override the derived value.
 */
fun versionCodeFor(version: String): Int {
    val match = Regex("""^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$""").find(version)
        ?: throw GradleException("package.json version '$version' is not semver (major.minor.patch[-prerelease])")
    val (major, minor, patch, pre) = match.destructured
    if (major.toInt() > 2100 || minor.toInt() > 99 || patch.toInt() > 99) {
        throw GradleException(
            "Cannot derive an Android versionCode from '$version' (major ≤ 2100, minor ≤ 99, patch ≤ 99); " +
                "pass -PversionCode=… or set ZEN_ANDROID_VERSION_CODE"
        )
    }
    val channel = if (pre.isEmpty()) {
        99
    } else {
        val number = pre.split('.', '-').lastOrNull { it.isNotEmpty() && it.all(Char::isDigit) }?.toInt() ?: 0
        when {
            pre.startsWith("alpha") -> minOf(number, 29)
            pre.startsWith("beta") -> 30 + minOf(number, 29)
            pre.startsWith("rc") -> 60 + minOf(number, 29)
            else -> 90 + minOf(number, 8)
        }
    }
    return major.toInt() * 1_000_000 + minor.toInt() * 10_000 + patch.toInt() * 100 + channel
}

val appVersionCode: Int =
    (System.getenv("ZEN_ANDROID_VERSION_CODE") ?: project.findProperty("versionCode")?.toString())
        ?.takeIf { it.isNotBlank() }?.toInt()
        ?: versionCodeFor(appVersion)

/**
 * Release signing comes from the environment (CI secrets) or from Gradle properties, e.g. in
 * ~/.gradle/gradle.properties. Without a keystore the release build falls back to the CI debug
 * key below.
 */
fun signingSetting(env: String, property: String): String? =
    (System.getenv(env) ?: project.findProperty(property)?.toString())?.takeIf { it.isNotBlank() }

val releaseKeystore = signingSetting("ZEN_ANDROID_KEYSTORE_FILE", "zen.android.keystoreFile")

/**
 * `android/ci-debug.keystore` is committed to the repository with a well-known password. It is a
 * *debug* key – anyone can sign with it, exactly like Android's standard debug keystore – but it
 * is the *same* key on every machine and every CI run. Android's own debug key is generated per
 * machine, so every CI runner would sign with a different key and no debug-keyed APK could ever
 * upgrade another in place. With this key every debug build (CI artifacts, GitHub releases built
 * without ANDROID_KEYSTORE_*) upgrades the previous one, including through the in-app updater,
 * which only ever installs an APK whose SHA-256 matches the release manifest. Switching to the
 * project release keystore later means one final uninstall for users of debug-keyed builds.
 */
val ciDebugKeystore = rootProject.file("ci-debug.keystore")
val ciDebugAlias = "zenium-ci-debug"
val ciDebugPassword = "zenium-ci-debug"

android {
    // The code package (R, BuildConfig, relative class names in the manifest). It moves together
    // with the Kotlin sources in a later pass; the app's identity on the device is applicationId.
    namespace = "app.zen.chromium"
    compileSdk = 35

    defaultConfig {
        // Zenium is a new app to Android: it installs alongside the old app.zen.chromium "Zen"
        // (v0.2.0 and earlier), which nothing can migrate; the updater says so (src/core/updates.ts).
        applicationId = "io.github.benitbuhner.zenium"
        minSdk = 26
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersion
        // Instrumentation (the gesture demo driver under src/androidTest); never part of the app.
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        // Point the chrome at the Vite dev server: ./gradlew installDebug -PdevServer=http://10.0.2.2:41734/
        buildConfigField(
            "String",
            "DEV_SERVER_URL",
            "\"${project.findProperty("devServer") ?: ""}\""
        )
    }

    signingConfigs {
        getByName("debug") {
            storeFile = ciDebugKeystore
            storePassword = ciDebugPassword
            keyAlias = ciDebugAlias
            keyPassword = ciDebugPassword
        }
        if (releaseKeystore != null) {
            create("release") {
                storeFile = rootProject.file(releaseKeystore)
                storePassword = signingSetting("ZEN_ANDROID_KEYSTORE_PASSWORD", "zen.android.keystorePassword")
                    ?: throw GradleException("ZEN_ANDROID_KEYSTORE_PASSWORD / zen.android.keystorePassword is required with a release keystore")
                keyAlias = signingSetting("ZEN_ANDROID_KEY_ALIAS", "zen.android.keyAlias")
                    ?: throw GradleException("ZEN_ANDROID_KEY_ALIAS / zen.android.keyAlias is required with a release keystore")
                keyPassword = signingSetting("ZEN_ANDROID_KEY_PASSWORD", "zen.android.keyPassword")
                    ?: throw GradleException("ZEN_ANDROID_KEY_PASSWORD / zen.android.keyPassword is required with a release keystore")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = if (releaseKeystore != null) {
                signingConfigs.getByName("release")
            } else {
                logger.warn(
                    "No release keystore configured (ZEN_ANDROID_KEYSTORE_FILE); the release APK is signed " +
                        "with the committed CI debug key (android/ci-debug.keystore), not a release key."
                )
                signingConfigs.getByName("debug")
            }
        }
        debug {
            applicationIdSuffix = ".debug"
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    sourceSets["main"].java.srcDirs("src/main/kotlin")
    sourceSets["test"].java.srcDirs("src/test/kotlin")
    sourceSets["androidTest"].java.srcDirs("src/androidTest/kotlin")

    packaging {
        resources.excludes += setOf("META-INF/*.version", "META-INF/LICENSE*")
    }
}

// app/build/outputs/apk/<type>/zenium-<version>-<type>.apk instead of app-<type>.apk
base {
    archivesName.set("zenium-$appVersion")
}

tasks.named("preBuild") { dependsOn(buildWeb, copyBlockingSnapshot, copySafeBrowsingSnapshot) }

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    // 1.13 adds WebStorageCompat.deleteBrowsingDataForSite (the site-information sheet's "clear all site data");
    // 1.17 adds JS_INJECTION_IN_FRAME_AND_WORLD (isolated worlds for the extension layer, Chromium 146+ WebView)
    // and names the origin-matched request headers Profile.addCustomHeader (GPC / DNT on every request, privacy/Privacy.kt).
    implementation("androidx.webkit:webkit:1.17.0")
    implementation("com.google.android.material:material:1.12.0")
    // Custom Tabs provider: the service other apps bind and the intent extras they send
    // (CustomTabsConnectionService.kt, CustomTabConfig.kt).
    implementation("androidx.browser:browser:1.8.0")
    // The share sheet's "QR code" action draws the link as a code (Share.kt); pure Java, no camera.
    implementation("com.google.zxing:core:3.5.3")
    // Password manager re-authentication: the system biometric / device credential sheet.
    implementation("androidx.biometric:biometric:1.1.0")

    // JVM unit tests (src/test): pure logic such as the screenshot stitching geometry and the
    // vault key wrapping format. The extension and vault tests build org.json documents, which
    // android.jar only stubs.
    testImplementation("junit:junit:4.13.2")
    // The request engine's rule sets are org.json documents; the real library stands in for the
    // android.jar stubs (which throw) so the blocking tests can parse them on the JVM.
    testImplementation("org.json:json:20250107")

    // On-device driver for the gesture demo recording (.github/workflows/android-gesture-demo.yml).
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("junit:junit:4.13.2")
}
