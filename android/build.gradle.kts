// Встроенный в AGP Kotlin — 2.2, а Filament тянет stdlib 2.4: компилятор
// должен быть не старше библиотеки.
buildscript {
    dependencies { classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.4.21") }
}

plugins {
    id("com.android.application") version "9.4.1"
}

android {
    namespace = "info.arenoros.aquarium"
    compileSdk = 37

    defaultConfig {
        applicationId = "info.arenoros.aquarium"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "0.1"
        ndk { abiFilters += listOf("armeabi-v7a", "arm64-v8a") }
    }

    // Пробник берёт пак (собирается tools/make-test-pack.js или convert-pack.ps1)
    // и фоны прямо из веб-части: копий в android/ нет.
    sourceSets["main"].assets.srcDirs("../assets/models", "../assets/backgrounds/webp", "../assets/coloring")

    // Один ключ на все сборки: APK с другим ключом не встанет поверх, и
    // переустановка сотрёт рисунки на ТВ (docs/adr/0001-tv-hub-webview.md).
    // Пароль кладётся в ~/.gradle/gradle.properties: aquaStorePassword=…
    val storePass = providers.gradleProperty("aquaStorePassword").orNull
    signingConfigs {
        create("aqua") {
            storeFile = file(providers.gradleProperty("aquaKeystore")
                .getOrElse("../../keystore/arenoros.info.jks"))
            storePassword = storePass
            keyAlias = "alias_name"
            keyPassword = storePass
        }
    }
    buildTypes {
        // Без пароля debug подписывается отладочным ключом — годится только
        // для пробников без данных, перед настоящей установкой их удаляют.
        debug { if (storePass != null) signingConfig = signingConfigs.getByName("aqua") }
        release { signingConfig = signingConfigs.getByName("aqua") }
    }
}

dependencies {
    val filament = "1.77.3"
    implementation("com.google.android.filament:filament-android:$filament")
    implementation("com.google.android.filament:gltfio-android:$filament")
    implementation("com.google.android.filament:filamat-android:$filament")
}
