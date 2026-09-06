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

android {
    namespace = "app.zen.chromium"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.zen.chromium"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = versionProps.getProperty("version")
        // Point the chrome at the Vite dev server: ./gradlew installDebug -PdevServer=http://10.0.2.2:41734/
        buildConfigField(
            "String",
            "DEV_SERVER_URL",
            "\"${project.findProperty("devServer") ?: ""}\""
        )
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
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

tasks.named("preBuild") { dependsOn(buildWeb) }

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("com.google.android.material:material:1.12.0")
}
