plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "wtf.spindle"
    compileSdk = 34

    defaultConfig {
        applicationId = "wtf.spindle"
        minSdk = 29
        targetSdk = 34
        versionCode = 1
        versionName = "1.2.0"
        ndk { abiFilters += listOf("arm64-v8a") }
    }

    // The Go server ships as libspindle.so and is exec'd as a child process —
    // it must exist as a real file on disk, not be loaded from the APK.
    packaging { jniLibs { useLegacyPackaging = true } }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.11.0")
}
