import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Written by `npm run pair-watch` in ../bridge; holds the Mac's address and the shared token.
val bridge = Properties().apply {
    val f = rootProject.file("bridge.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "dev.diel.watch"
    compileSdk = 34

    defaultConfig {
        applicationId = "dev.diel.watch"
        minSdk = 30
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
        buildConfigField("String", "BRIDGE_HOST", "\"${bridge.getProperty("host", "")}\"")
        buildConfigField("int", "BRIDGE_PORT", bridge.getProperty("port", "8791"))
        buildConfigField("String", "BRIDGE_TOKEN", "\"${bridge.getProperty("token", "")}\"")
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2024.10.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.wear.compose:compose-material:1.4.1")
    implementation("androidx.wear.compose:compose-foundation:1.4.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
}
