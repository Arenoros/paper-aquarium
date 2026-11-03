package info.arenoros.aquarium

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlin.random.Random

// Аквариум ТВ на диске — в том же виде, что data/tanks/<код>/ у server.js:
// fish/<id>.json (+ <id>.png у раскрашенных), settings.json, meta.json,
// удалённое — в trash/. Один аквариум на ТВ (ADR 0001), поэтому без кода
// и без пароля. Пишет встроенный сервер (из своих потоков), читает сцена.
class TankStore(val dir: File) {
    /** pack — модель готовой рыбки; иначе kind — вид раскраски и рисунок рядом. */
    class Rec(val id: String, val kind: String, val pack: String?)

    private val fishDir = File(dir, "fish")
    private val trashDir = File(dir, "trash")
    private val settingsFile = File(dir, "settings.json")
    private val metaFile = File(dir, "meta.json")

    private fun records(): List<JSONObject> = (fishDir.listFiles { f -> f.name.endsWith(".json") } ?: emptyArray())
        .mapNotNull { f -> runCatching { JSONObject(f.readText()) }.getOrNull() }
        .sortedBy { it.optString("id") }

    fun fish(): List<Rec> = records().mapNotNull { j ->
        runCatching {
            // у старых записей type нет — они раскрашенные
            if (j.optString("type") == "pack") Rec(j.getString("id"), j.optString("model"), j.optString("model"))
            else Rec(j.getString("id"), j.getString("kind"), null)
        }.getOrNull()
    }

    /** Список рыбок, как его отдаёт GET …/fish у server.js. */
    fun fishJson(): String = JSONArray(records()).toString()

    fun count() = fishDir.listFiles { f -> f.name.endsWith(".json") }?.size ?: 0

    fun texture(id: String) = File(fishDir, "$id.png")

    /** Раскрашенная: сначала рисунок, потом запись — сцена не увидит рыбку без картинки. */
    @Synchronized fun addPainted(kind: String, image: ByteArray): String {
        val id = newId()
        write(File(fishDir, "$id.png"), image)
        write(File(fishDir, "$id.json"), JSONObject().put("id", id).put("kind", kind).put("created", now()).toString().toByteArray())
        return id
    }

    @Synchronized fun addPack(model: String, title: String): String {
        val id = newId()
        write(File(fishDir, "$id.json"), JSONObject().put("id", id).put("type", "pack").put("model", model)
            .put("title", title).put("created", now()).toString().toByteArray())
        return id
    }

    // Удаление — перенос в корзину, а не стирание: внутри детские рисунки.
    @Synchronized fun trash(id: String): Boolean {
        trashDir.mkdirs()
        var n = 0
        for (ext in listOf(".json", ".png")) {
            val f = File(fishDir, id + ext)
            if (f.exists() && f.renameTo(File(trashDir, id + ext))) n++
        }
        return n > 0
    }

    @Synchronized fun trashAll(): Int = fish().count { trash(it.id) }

    fun background(): String? = runCatching { JSONObject(settingsFile.readText()).optString("background") }
        .getOrNull()?.ifEmpty { null }

    @Synchronized fun setBackground(name: String) = write(settingsFile, JSONObject().put("background", name).toString().toByteArray())

    fun name(): String = runCatching { JSONObject(metaFile.readText()).optString("name") }.getOrNull()?.ifEmpty { null } ?: "Мой аквариум"
    fun created(): String = runCatching { JSONObject(metaFile.readText()).optString("created") }.getOrNull()?.ifEmpty { null } ?: now()

    @Synchronized fun setName(name: String) =
        write(metaFile, JSONObject().put("name", name).put("created", created()).toString().toByteArray())

    // Через временный файл и переименование: сцена в другом потоке не прочтёт
    // запись наполовину.
    private fun write(f: File, bytes: ByteArray) {
        f.parentFile?.mkdirs()
        val tmp = File(f.parentFile, f.name + ".tmp")
        tmp.writeBytes(bytes)
        if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f) }
    }

    // Как у server.js: время в base36 и четыре случайных знака.
    private fun newId() = System.currentTimeMillis().toString(36) + "-" +
        (1..4).map { "0123456789abcdefghijklmnopqrstuvwxyz"[Random.nextInt(36)] }.joinToString("")

    // java.time — только с API 26, а minSdk 24
    private fun now() = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        .apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date())
}
