plugins {
    id("com.android.application") version "9.4.1"
}

android {
    namespace = "info.arenoros.aquarium"
    compileSdk = 36

    defaultConfig {
        applicationId = "info.arenoros.aquarium"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "0.1"
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
