import javax.inject.Inject

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

// Веб-часть, которую ТВ раздаёт телефону и из которой сам берёт пак и фоны:
// те же пути, что у сайта, под web/ в assets APK. Копий в android/ нет —
// пак собирается tools/make-test-pack.js или convert-pack.ps1 на месте.
// PNG-фоны (22 МБ) не едут: у каждого есть webp той же картинки.
abstract class WebRoot : DefaultTask() {
    @get:InputFiles abstract val sources: ConfigurableFileCollection
    @get:OutputDirectory abstract val outputDir: DirectoryProperty
    @get:Inject abstract val fs: FileSystemOperations

    @TaskAction fun copy() {
        fs.sync {
            from(sources.asFileTree)
            into(outputDir.dir("web"))
        }
    }
}

val webRoot = tasks.register<WebRoot>("webRoot") {
    sources.from(fileTree("..") {
        include("demos/realistic-tank.html", "demos/garden.html", "capture.html", "admin.html", "print.html", "favicon.ico", "assets/**", "vendor/**")
        exclude("assets/backgrounds/*.png", "assets/models/README.md")
    })
    outputDir.set(layout.buildDirectory.dir("webroot"))
}

androidComponents {
    onVariants { it.sources.assets?.addGeneratedSourceDirectory(webRoot, WebRoot::outputDir) }
}

dependencies {
    val filament = "1.77.3"
    implementation("com.google.android.filament:filament-android:$filament")
    implementation("com.google.android.filament:gltfio-android:$filament")
    implementation("com.google.android.filament:filamat-android:$filament")
    implementation("org.nanohttpd:nanohttpd:2.3.1")
    implementation("com.google.zxing:core:3.5.3")
}
