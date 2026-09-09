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
    description = "Builds the Zen chrome and page script into app/src/main/assets"
    workingDir = webRoot
    val npm = if (System.getProperty("os.name").lowercase().contains("win")) "npm.cmd" else "npm"
    commandLine(npm, "run", "build:android:web")
    inputs.dir(webRoot.resolve("src"))
    outputs.dir(projectDir.resolve("src/main/assets/www"))
    outputs.file(projectDir.resolve("src/main/assets/page.js"))
    onlyIf { !skipWeb }
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
 * ~/.gradle/gradle.properties. Without a keystore the release build is signed with the debug key
 * so it still installs, but every such build carries a different signature and cannot upgrade an
 * earlier install in place.
 */
fun signingSetting(env: String, property: String): String? =
    (System.getenv(env) ?: project.findProperty(property)?.toString())?.takeIf { it.isNotBlank() }

val releaseKeystore = signingSetting("ZEN_ANDROID_KEYSTORE_FILE", "zen.android.keystoreFile")

android {
    namespace = "app.zen.chromium"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.zen.chromium"
        minSdk = 26
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersion
        // Point the chrome at the Vite dev server: ./gradlew installDebug -PdevServer=http://10.0.2.2:41734/
        buildConfigField(
            "String",
            "DEV_SERVER_URL",
            "\"${project.findProperty("devServer") ?: ""}\""
        )
    }

    signingConfigs {
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
                    "No release keystore configured (ZEN_ANDROID_KEYSTORE_FILE); the release APK will be " +
                        "signed with the debug key and cannot upgrade a properly signed install."
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

    packaging {
        resources.excludes += setOf("META-INF/*.version", "META-INF/LICENSE*")
    }
}

// app/build/outputs/apk/<type>/zen-chromium-<version>-<type>.apk instead of app-<type>.apk
base {
    archivesName.set("zen-chromium-$appVersion")
}

tasks.named("preBuild") { dependsOn(buildWeb) }

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("com.google.android.material:material:1.12.0")
}
