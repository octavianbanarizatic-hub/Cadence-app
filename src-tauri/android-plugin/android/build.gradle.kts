plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.cadence.android"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.9.0")
    implementation("androidx.activity:activity-ktx:1.10.1")
    // Tauri's lifecycle hooks (onPause) take an AppCompatActivity.
    implementation("androidx.appcompat:appcompat:1.7.1")
    // MediaSession and the media notification style (lock screen controls).
    implementation("androidx.media:media:1.7.0")
    // New release checks twice a day, with Cadence closed too (Releases).
    implementation("androidx.work:work-runtime-ktx:2.10.1")
    implementation(project(":tauri-android"))
    // Python, yt-dlp and QuickJS, packaged as native libraries.
    implementation("io.github.junkfood02.youtubedl-android:library:0.18.1")
}
