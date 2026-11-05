package info.arenoros.aquarium

import android.content.res.AssetManager
import android.graphics.BitmapFactory
import android.util.Base64
import android.util.Log
import fi.iki.elonen.NanoHTTPD
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream

// Встроенный сервер ТВ: страницы сайта и те ручки server.js, которые они
// зовут, в том же формате — capture.html, admin.html и сама сцена работают
// без правок (docs/adr/0001-tv-hub-webview.md). Телефон открывает аквариум
// по QR с экрана и шлёт рыбок сюда.
//
// Чего нет и почему: паролей и пинов (аквариум один, сеть домашняя — удалённое
// всё равно уходит в корзину), своих фонов, снимков-превью, потока событий —
// /events отвечает 503, и страница сама переходит на редкие опросы, а сцена
// ТВ узнаёт обо всём сразу, через callbacks.
class TankServer(
    private val assets: AssetManager,
    private val store: TankStore,
    private val kinds: Set<String>,
    private val events: Events,
    private val cache: java.io.File,
) : NanoHTTPD(PORT) {
    interface Events {
        fun fishChanged()
        fun settingsChanged()
        fun feed()
    }

    @Volatile private var feedAt = 0L
    private val gardenKinds: Set<String> = JSONObject(assets.open("web/assets/garden/manifest.json").use { it.readBytes().toString(Charsets.UTF_8) })
        .getJSONArray("fish").let { a -> (0 until a.length()).map { a.getJSONObject(it).getString("name") }.toSet() }

    override fun serve(s: IHTTPSession): Response = try {
        route(s)
    } catch (e: Throwable) {
        // запрос целиком под перехватом: 500 вместо упавшего потока сервера
        Log.e("aqua", "запрос ${s.method} ${s.uri.take(200)}", e)
        json(Response.Status.INTERNAL_ERROR, """{"error":"ошибка сервера"}""")
    }

    private fun route(s: IHTTPSession): Response {
        val uri = s.uri
        // обратный слеш и «..» — мимо раздачи статики на любой ОС
        if (uri.contains("..") || uri.contains('\\')) return notFound()
        if (uri == "/" || uri == "/index.html") return redirect(TANK_URL)
        if (uri == "/backup.zip") return backup(s)
        if (uri.startsWith("/api/")) return api(s, uri)
        if (uri == TANK_URL || uri == "$TANK_URL/") return file(if (store.world() == "garden") "demos/garden.html" else "demos/realistic-tank.html")
        PAGES[uri]?.let { return file(it) }
        if (uri.startsWith("/assets/") || uri.startsWith("/vendor/") || uri == "/favicon.ico" || uri == "/print.html") {
            return file(uri.removePrefix("/"))
        }
        return notFound()
    }

    private fun api(s: IHTTPSession, uri: String): Response {
        val get = s.method == Method.GET
        if (get && uri == "/api/pack") return json(Response.Status.OK, packList())
        if (!uri.startsWith(API)) return json(Response.Status.NOT_FOUND, """{"error":"нет такого аквариума"}""")
        val u = uri.removePrefix(API).ifEmpty { "/" }
        val m = s.method
        // Тело читаем до любых проверок: ответ раньше, чем клиент дослал
        // картинку, NanoHTTPD отдаёт обрывом соединения, и страница съёмки
        // показала бы «нет связи» вместо «в аквариуме тесно».
        val data = if (m == Method.POST || m == Method.PUT || m == Method.PATCH) body(s) else null
        val fishTexture = Regex("^/fish/([a-z0-9-]+)/texture\\.png$").find(u)
        val fishOne = Regex("^/fish/([a-z0-9-]+)$").find(u)
        return when {
            get && u == "/meta" -> json(Response.Status.OK, meta().toString())
            m == Method.PATCH && u == "/meta" -> {
                val name = clean(data?.optString("name"), 60)
                if (name.isNotEmpty()) store.setName(name)
                json(Response.Status.OK, meta().toString())
            }
            // пароля на ТВ нет: админка видит locked = false и пускает сама
            m == Method.POST && u == "/auth" -> json(Response.Status.OK, """{"ok":true,"locked":false}""")
            m == Method.POST && u == "/password" -> json(Response.Status.FORBIDDEN, """{"error":"на телевизоре пароля нет"}""")
            get && u == "/events" -> json(Response.Status.SERVICE_UNAVAILABLE, """{"error":"потока событий нет — опросы"}""")
            get && u == "/fish" -> json(Response.Status.OK, store.fishJson())
            get && fishTexture != null -> {
                val f = store.texture(fishTexture.groupValues[1])
                if (!f.exists()) notFound() else newFixedLengthResponse(Response.Status.OK, "image/png", f.inputStream(), f.length())
            }
            m == Method.POST && u == "/fish" -> addFish(data)
            m == Method.DELETE && fishOne != null -> {
                val ok = store.trash(fishOne.groupValues[1])
                if (ok) events.fishChanged()
                json(if (ok) Response.Status.OK else Response.Status.NOT_FOUND, """{"ok":$ok}""")
            }
            m == Method.DELETE && u == "/fish" -> {
                val n = store.trashAll()
                events.fishChanged()
                json(Response.Status.OK, """{"ok":true,"removed":$n}""")
            }
            get && u == "/backgrounds" -> json(Response.Status.OK, JSONArray(backgrounds().map {
                JSONObject().put("name", it).put("url", backgroundUrl(it)).put("custom", false)
            }).toString())
            m == Method.POST && u == "/backgrounds" -> json(Response.Status.FORBIDDEN, """{"error":"на телевизоре только встроенные фоны"}""")
            get && u == "/settings" -> json(Response.Status.OK, settings().toString())
            (m == Method.POST || m == Method.PUT) && u == "/settings" -> {
                val bg = data?.optString("background")
                // неизвестное имя фона не оставляет аквариум пустым — сохраняем прежний
                if (bg != null && bg in backgrounds()) store.setBackground(bg)
                val world = data?.optString("world")
                if (world == "garden" || world == "aquarium") store.setWorld(world)
                val weather = data?.optString("gardenWeather")
                if (weather == "sun" || weather == "rain") store.setGardenWeather(weather)
                events.settingsChanged()
                json(Response.Status.OK, settings().toString())
            }
            m == Method.POST && u == "/feed" -> {
                feedAt = System.currentTimeMillis()
                events.feed()
                json(Response.Status.OK, """{"ok":true,"feedAt":$feedAt}""")
            }
            // снимок для карточки на главной сайта — у ТВ главной нет
            m == Method.POST && u == "/preview" -> json(Response.Status.OK, """{"ok":true}""")
            else -> json(Response.Status.NOT_FOUND, """{"error":"unknown api"}""")
        }
    }

    // Бэкап — zip папки аквариума: GET скачать, POST — восстановить из него.
    //   curl -o aquarium.zip http://<ТВ>:8000/backup.zip
    //   curl --data-binary @aquarium.zip -H "Content-Type: application/zip" http://<ТВ>:8000/backup.zip
    private fun backup(s: IHTTPSession): Response = when (s.method) {
        Method.GET -> {
            val f = java.io.File(cache, "backup.zip")
            store.backup(f)
            newFixedLengthResponse(Response.Status.OK, "application/zip", f.inputStream(), f.length()).apply {
                addHeader("Content-Disposition", "attachment; filename=\"aquarium-backup.zip\"")
            }
        }
        Method.POST, Method.PUT -> {
            val len = s.headers["content-length"]?.toLongOrNull() ?: -1
            if (len <= 0 || len > RESTORE_BYTES) json(Response.Status.PAYLOAD_TOO_LARGE, """{"error":"нужен zip до 512 МБ"}""")
            else {
                val f = java.io.File(cache, "restore.zip")
                f.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    var left = len
                    val input = s.inputStream
                    while (left > 0) { val n = input.read(buf, 0, minOf(buf.size.toLong(), left).toInt()); if (n < 0) break; out.write(buf, 0, n); left -= n }
                }
                val ok = store.restore(f)
                f.delete()
                if (ok) { Log.i("aqua", "аквариум восстановлен из бэкапа"); events.fishChanged(); events.settingsChanged() }
                if (ok) json(Response.Status.OK, """{"ok":true,"fishCount":${store.count()}}""")
                else json(Response.Status.BAD_REQUEST, """{"error":"это не бэкап аквариума"}""")
            }
        }
        else -> notFound()
    }

    // В аквариуме рыбки двух пород, и обе заводятся здесь (как у server.js):
    //   раскрашенные — {kind, texture}: рядом с записью ложится <id>.png;
    //   готовые      — {type:'pack', model}: картинка своя, внутри модели.
    private fun addFish(body: JSONObject?): Response {
        if (store.count() >= Aquarium.MAX_FISH) {
            return json(Response.Status.CONFLICT, JSONObject().put("error", "в аквариуме уже ${Aquarium.MAX_FISH} рыбок — тесно").toString())
        }
        val data = body ?: return json(Response.Status.BAD_REQUEST, """{"error":"тело запроса не JSON"}""")
        if (data.optString("type") == "pack") {
            val model = data.optString("model")
            val item = packItems().firstOrNull { it.optString("name") == model }
                ?: return json(Response.Status.BAD_REQUEST, """{"error":"нет такой модели в паке"}""")
            val id = store.addPack(model, item.optString("title", model))
            events.fishChanged()
            return json(Response.Status.OK, """{"ok":true,"id":"$id"}""")
        }
        // Вид — только из раскрасок (аудит 16.10.2026: строка без предела
        // уходила каждому зрителю аквариума).
        val kind = data.optString("kind")
        if (!Regex("^[a-z0-9-]{1,40}$").matches(kind) || (kind !in kinds && kind !in gardenKinds)) {
            return json(Response.Status.BAD_REQUEST, """{"error":"нет такой рыбки в раскрасках"}""")
        }
        val img = image(data.optString("texture"), FISH_BYTES)
            ?: return json(Response.Status.BAD_REQUEST, """{"error":"это не PNG и не JPEG или картинка слишком большая"}""")
        val id = store.addPainted(kind, img)
        Log.i("aqua", "+ рыбка $kind (${img.size / 1024} КБ)")
        events.fishChanged()
        return json(Response.Status.OK, """{"ok":true,"id":"$id"}""")
    }

    // Картинка из data:URL: тип по первым байтам, размер в точках по заголовку —
    // те же пределы, что у server.js.
    private fun image(dataUrl: String, maxBytes: Int): ByteArray? {
        val m = Regex("^data:image/(png|jpeg);base64,").find(dataUrl) ?: return null
        if (dataUrl.length - m.range.last > maxBytes * 4 / 3 + 4) return null
        val bytes = runCatching { Base64.decode(dataUrl.substring(m.range.last + 1), Base64.DEFAULT) }.getOrNull() ?: return null
        val png = bytes.size > 8 && bytes[0] == 0x89.toByte() && bytes[1] == 'P'.code.toByte() && bytes[2] == 'N'.code.toByte()
        val jpeg = bytes.size > 3 && bytes[0] == 0xFF.toByte() && bytes[1] == 0xD8.toByte() && bytes[2] == 0xFF.toByte()
        if (!(png && m.groupValues[1] == "png") && !(jpeg && m.groupValues[1] == "jpeg")) return null
        val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, o)
        if (o.outWidth <= 0 || o.outWidth > 4096 || o.outHeight <= 0 || o.outHeight > 4096) return null
        return bytes
    }

    private fun body(s: IHTTPSession): JSONObject? {
        val len = s.headers["content-length"]?.toLongOrNull() ?: return null
        if (len <= 0 || len > BODY_BYTES) return null
        val buf = ByteArray(len.toInt())
        var off = 0
        val input = s.inputStream
        while (off < buf.size) { val n = input.read(buf, off, buf.size - off); if (n < 0) break; off += n }
        return runCatching { JSONObject(String(buf, 0, off, Charsets.UTF_8)) }.getOrNull()
    }

    private fun meta() = JSONObject()
        .put("id", TANK_ID).put("name", store.name()).put("created", store.created())
        .put("locked", false)
        // страницы прячут то, чего у ТВ нет: пароль, пин, список аквариумов, свои фоны
        .put("local", true)
        .put("world", store.world())
        .put("fishCount", store.count())
        .put("preview", JSONObject.NULL)
        .put("backgroundUrl", store.background()?.let(::backgroundUrl) ?: JSONObject.NULL)

    private fun settings() = JSONObject()
        .put("world", store.world()).put("gardenWeather", store.gardenWeather())
        .put("background", store.background() ?: JSONObject.NULL)
        .put("backgroundUrl", store.background()?.let(::backgroundUrl) ?: JSONObject.NULL)
        .put("feedAt", feedAt)

    // Имена фонов — как у сервера («05-0.png»), а картинки на ТВ — webp тех же.
    private fun backgrounds(): List<String> =
        (assets.list(Aquarium.BG_DIR.trimEnd('/')) ?: emptyArray()).filter { it.endsWith(".webp") }.sorted()
            .map { it.removeSuffix(".webp") + ".png" }

    private fun backgroundUrl(name: String) = "/assets/backgrounds/webp/" + name.removeSuffix(".png") + ".webp"

    private fun packItems(): List<JSONObject> = runCatching {
        val a = JSONArray(assets.open(FishModel.PACK + "pack.json").use { it.readBytes().toString(Charsets.UTF_8) })
        List(a.length()) { a.getJSONObject(it) }
    }.getOrDefault(emptyList())

    // sheet — есть ли у вида лист раскраски: меню показывает только такие.
    private fun packList() = JSONArray(packItems().map { it.put("sheet", it.optString("name") in kinds) }).toString()

    private fun file(path: String): Response {
        val bytes = runCatching { assets.open("web/$path").use { it.readBytes() } }.getOrNull() ?: return notFound()
        val type = MIME[path.substringAfterLast('.', "").lowercase()] ?: "application/octet-stream"
        return newFixedLengthResponse(Response.Status.OK, type, ByteArrayInputStream(bytes), bytes.size.toLong()).apply {
            addHeader("X-Content-Type-Options", "nosniff")
        }
    }

    private fun clean(v: String?, max: Int) = (v ?: "").filter { !it.isISOControl() && it.category != CharCategory.FORMAT }.trim().take(max)

    private fun json(status: Response.Status, body: String) =
        newFixedLengthResponse(status, "application/json; charset=utf-8", body).apply { addHeader("Cache-Control", "no-store") }

    private fun notFound() = json(Response.Status.NOT_FOUND, """{"error":"not found"}""")

    private fun redirect(to: String) =
        newFixedLengthResponse(Response.Status.REDIRECT, "text/plain", "").apply { addHeader("Location", to) }

    companion object {
        const val PORT = 8000
        // Формат кода сайта (assets/tank.js: 10 знаков без i, l, o, 0, 1) — страницы его проверяют.
        const val TANK_ID = "tvtank2222"
        const val TANK_URL = "/t/$TANK_ID"
        private const val API = "/api/t/$TANK_ID"
        private const val FISH_BYTES = 3 * 1024 * 1024
        private const val BODY_BYTES = 12L * 1024 * 1024
        private const val RESTORE_BYTES = 512L * 1024 * 1024
        private val PAGES = mapOf(
            TANK_URL to "demos/realistic-tank.html", "$TANK_URL/" to "demos/realistic-tank.html",
            "$TANK_URL/capture" to "capture.html", "$TANK_URL/admin" to "admin.html",
        )
        private val MIME = mapOf(
            "html" to "text/html; charset=utf-8", "js" to "text/javascript; charset=utf-8", "css" to "text/css; charset=utf-8",
            "json" to "application/json", "gltf" to "model/gltf+json", "bin" to "application/octet-stream",
            "wasm" to "application/wasm", "png" to "image/png", "jpg" to "image/jpeg", "webp" to "image/webp",
            "svg" to "image/svg+xml", "ico" to "image/x-icon", "pdf" to "application/pdf",
        )
    }
}
