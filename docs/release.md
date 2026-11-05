# Релиз Android TV

[Release](../.github/workflows/release.yml) запускается при отправке тега
`vX.Y.Z` в GitHub. Workflow прогоняет `npm test`, собирает и проверяет
подписанный APK, затем публикует его в GitHub Releases. Один APK содержит
`armeabi-v7a` и `arm64-v8a`. В него входят 12 видов рыб, сгенерированных из
силуэтов в репозитории. Купленный пак предназначен для локальной сборки и
личной установки ([ADR 0001](adr/0001-tv-hub-webview.md)).

## Автообновление на ТВ

Сборка из GitHub Releases проверяет последнюю стабильную версию при запуске
и каждые шесть часов, пока приложение открыто. Интернет нужен для проверки
и загрузки. При первой доступной новой версии на Android 8 и новее нужно
разрешить «Аквариуму» установку из этого источника в настройках ТВ. На
Android 12 и новее приложение запрашивает установку без подтверждения.
Если система всё же запрашивает подтверждение, оно появится на экране ТВ.
Установка идёт поверх приложения с сохранением рисунков и настроек.

Чтобы включить автообновление, один раз установите релиз с этой функцией
поверх текущей версии. При последующих релизах приложение само скачивает
APK и передаёт его системному установщику. Локальные сборки по умолчанию
сохраняют свой комплект моделей. Для тестовой подписанной release-сборки
функцию можно включить параметром `-PaquaAutoUpdate=true`.

## Подпись

Ключ Paper Aquarium TV хранится в `../keystore/paper-aquarium-tv/release.p12`
с алиасом `alias_name`. Соседний файл `password.dpapi` зашифрован для
локальной учётной записи Windows. Добавьте два секрета GitHub Actions
через PowerShell из корня репозитория:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes((Resolve-Path '../keystore/paper-aquarium-tv/release.p12').Path)) |
  gh secret set SIGNING_KEYSTORE_BASE64 --repo Arenoros/paper-aquarium
$signingPassword = Get-Content -LiteralPath '../keystore/paper-aquarium-tv/password.dpapi' -Raw | ConvertTo-SecureString
[Net.NetworkCredential]::new('', $signingPassword).Password |
  gh secret set SIGNING_PASSWORD --repo Arenoros/paper-aquarium
```

Тот же пароль Gradle принимает как `aquaStorePassword`. Для независимой
резервной копии сохраните ключ и пароль в менеджере паролей.

Если на ТВ стоит сборка с прежней подписью, сначала скачайте резервную
копию аквариума. Затем удалите прежнюю сборку, установите APK с новым
ключом и [восстановите данные](../README.ru.md#тв-приложение-аквариум-без-интернета).

## Выпуск

Сначала закоммитьте Android-приложение и workflow. Команда ниже проверяет,
что `release.yml` входит в `HEAD`, и только после этого создаёт тег.
Сообщение тега станет описанием релиза.

```bash
git cat-file -e HEAD:.github/workflows/release.yml &&
  git tag -a v0.1.0 -m "Первый выпуск для Android TV" &&
  git push origin v0.1.0
```

Для `v0.1.0` файл будет называться `paper-aquarium-tv-0.1.0.apk`.
`versionName` берётся из тега, `versionCode` вычисляется как
`X * 10000 + Y * 100 + Z`, где `Y` и `Z` меньше 100. Для локальной сборки
обновления укажите нужную версию через `-PaquaReleaseVersion=0.1.0`.
