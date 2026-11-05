package info.arenoros.aquarium

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream
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

    private fun settings(): JSONObject = runCatching { JSONObject(settingsFile.readText()) }.getOrElse { JSONObject() }

    fun background(): String? = settings().optString("background").ifEmpty { null }

    fun world(): String = if (settings().optString("world") == "garden") "garden" else "aquarium"
    fun gardenWeather(): String = if (settings().optString("gardenWeather") == "rain") "rain" else "sun"

    @Synchronized fun setWorld(name: String) = write(settingsFile, settings().put("world", name).toString().toByteArray())
    @Synchronized fun setGardenWeather(name: String) = write(settingsFile, settings().put("gardenWeather", name).toString().toByteArray())

    @Synchronized fun setBackground(name: String) = write(settingsFile, settings().put("background", name).toString().toByteArray())

    fun name(): String = runCatching { JSONObject(metaFile.readText()).optString("name") }.getOrNull()?.ifEmpty { null } ?: "Мой аквариум"
    fun created(): String = runCatching { JSONObject(metaFile.readText()).optString("created") }.getOrNull()?.ifEmpty { null } ?: now()

    @Synchronized fun setName(name: String) =
        write(metaFile, JSONObject().put("name", name).put("created", created()).toString().toByteArray())

    // ── бэкап ───────────────────────────────────────────────────────────────
    // adb до данных release-сборки на Android 14 не достаёт, поэтому бэкап —
    // zip всей папки аквариума по HTTP, вместе с корзиной.
    @Synchronized fun backup(out: File) {
        ZipOutputStream(out.outputStream().buffered()).use { z ->
            dir.walkTopDown().filter { it.isFile && !it.name.endsWith(".tmp") }.forEach { f ->
                z.putNextEntry(ZipEntry(f.relativeTo(dir).invariantSeparatorsPath))
                f.inputStream().use { it.copyTo(z) }
                z.closeEntry()
            }
        }
    }

    /**
     * Восстановление из того же zip. Имена — только по образцу аквариума,
     * размеры ограничены. Прежняя папка остаётся рядом как tank.prev:
     * восстановление не должно стирать рисунки насовсем.
     */
    @Synchronized fun restore(zip: File): Boolean {
        val fresh = File(dir.parentFile, dir.name + ".new").apply { deleteRecursively(); mkdirs() }
        val ok = runCatching {
            var total = 0L
            ZipInputStream(zip.inputStream().buffered()).use { z ->
                while (true) {
                    val e = z.nextEntry ?: break
                    if (e.isDirectory) continue
                    require(ENTRY.matches(e.name)) { "чужой файл в архиве: ${e.name.take(80)}" }
                    val f = File(fresh, e.name)
                    f.parentFile?.mkdirs()
                    f.outputStream().use { out ->
                        val buf = ByteArray(64 * 1024)
                        var n = 0L
                        while (true) {
                            val r = z.read(buf)
                            if (r < 0) break
                            n += r; total += r
                            require(n <= ENTRY_BYTES && total <= TOTAL_BYTES) { "архив слишком большой" }
                            out.write(buf, 0, r)
                        }
                    }
                }
            }
        }.isSuccess
        if (!ok) { fresh.deleteRecursively(); return false }
        val prev = File(dir.parentFile, dir.name + ".prev")
        prev.deleteRecursively()
        if (dir.exists() && !dir.renameTo(prev)) { fresh.deleteRecursively(); return false }
        return fresh.renameTo(dir)
    }

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

    private companion object {
        val ENTRY = Regex("""^(fish|trash)/[a-z0-9-]{1,40}\.(json|png)$|^(settings|meta)\.json$""")
        const val ENTRY_BYTES = 16L * 1024 * 1024
        const val TOTAL_BYTES = 1024L * 1024 * 1024
    }

    // java.time — только с API 26, а minSdk 24
    private fun now() = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        .apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date())
}
