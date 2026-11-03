package info.arenoros.aquarium

import org.json.JSONObject
import java.io.File

// Аквариум ТВ на диске — в том же виде, что data/tanks/<код>/ у server.js:
// fish/<id>.json (+ <id>.png у раскрашенных), settings.json. Один аквариум
// на ТВ (ADR 0001), поэтому без кода и без meta.json.
class TankStore(val dir: File) {
    /** pack — модель готовой рыбки; иначе kind — вид раскраски и рисунок рядом. */
    class Rec(val id: String, val kind: String, val pack: String?)

    private val fishDir = File(dir, "fish")
    private val settingsFile = File(dir, "settings.json")

    fun fish(): List<Rec> = (fishDir.listFiles { f -> f.name.endsWith(".json") } ?: emptyArray())
        .mapNotNull { f ->
            runCatching {
                val j = JSONObject(f.readText())
                // у старых записей type нет — они раскрашенные
                if (j.optString("type") == "pack") Rec(j.getString("id"), j.optString("model"), j.optString("model"))
                else Rec(j.getString("id"), j.getString("kind"), null)
            }.getOrNull()
        }
        .sortedBy { it.id }

    fun texture(id: String) = File(fishDir, "$id.png")

    fun background(): String? = runCatching { JSONObject(settingsFile.readText()).optString("background") }
        .getOrNull()?.ifEmpty { null }

    fun setBackground(name: String) {
        dir.mkdirs()
        settingsFile.writeText(JSONObject().put("background", name).toString())
    }
}
