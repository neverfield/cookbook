plugins {
    alias(libs.plugins.android.application)
}

android {
    namespace = "com.example.notes"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.example.notes"
        minSdk = 26
        targetSdk = 35
    }
}
