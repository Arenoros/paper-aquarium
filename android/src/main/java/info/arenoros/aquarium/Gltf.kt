package info.arenoros.aquarium

import android.opengl.Matrix
import org.json.JSONArray
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder

// Чтение glTF там, куда gltfio заглянуть не даёт: вершины — для габаритов и
// центра масс, дорожки клипа — для темпа взмахов и среза движения корня.
// Только .gltf с внешними буферами — ровно то, что собирают convert-pack.ps1
// и make-test-pack.js.
class Gltf(val json: JSONObject, private val buffers: List<ByteBuffer>) {
    private val accessors: JSONArray = json.optJSONArray("accessors") ?: JSONArray()
    private val views: JSONArray = json.optJSONArray("bufferViews") ?: JSONArray()
    val nodes: JSONArray = json.optJSONArray("nodes") ?: JSONArray()

    // Мировая матрица каждого узла от корней сцены (column-major, как у Filament).
    val world: Array<FloatArray> = Array(nodes.length()) { FloatArray(16).also { Matrix.setIdentityM(it, 0) } }

    init {
        val scene = json.optJSONArray("scenes")?.optJSONObject(json.optInt("scene", 0))
        val roots = scene?.optJSONArray("nodes") ?: JSONArray()
        val id = FloatArray(16).also { Matrix.setIdentityM(it, 0) }
        for (i in 0 until roots.length()) visit(roots.getInt(i), id)
    }

    private fun visit(i: Int, parent: FloatArray) {
        Matrix.multiplyMM(world[i], 0, parent, 0, local(nodes.getJSONObject(i)), 0)
        val kids = nodes.getJSONObject(i).optJSONArray("children") ?: return
        for (k in 0 until kids.length()) visit(kids.getInt(k), world[i])
    }

    private fun local(n: JSONObject): FloatArray {
        val m = FloatArray(16)
        n.optJSONArray("matrix")?.let { a -> for (k in 0 until 16) m[k] = a.getDouble(k).toFloat(); return m }
        val t = n.optJSONArray("translation"); val r = n.optJSONArray("rotation"); val s = n.optJSONArray("scale")
        val (qx, qy, qz, qw) = if (r != null) List(4) { r.getDouble(it).toFloat() } else listOf(0f, 0f, 0f, 1f)
        val sx = s?.getDouble(0)?.toFloat() ?: 1f; val sy = s?.getDouble(1)?.toFloat() ?: 1f; val sz = s?.getDouble(2)?.toFloat() ?: 1f
        // T · R · S
        m[0] = (1 - 2 * (qy * qy + qz * qz)) * sx; m[1] = (2 * (qx * qy + qz * qw)) * sx; m[2] = (2 * (qx * qz - qy * qw)) * sx
        m[4] = (2 * (qx * qy - qz * qw)) * sy; m[5] = (1 - 2 * (qx * qx + qz * qz)) * sy; m[6] = (2 * (qy * qz + qx * qw)) * sy
        m[8] = (2 * (qx * qz + qy * qw)) * sz; m[9] = (2 * (qy * qz - qx * qw)) * sz; m[10] = (1 - 2 * (qx * qx + qy * qy)) * sz
        m[12] = t?.getDouble(0)?.toFloat() ?: 0f; m[13] = t?.getDouble(1)?.toFloat() ?: 0f; m[14] = t?.getDouble(2)?.toFloat() ?: 0f
        m[15] = 1f
        return m
    }

    fun nodeName(i: Int): String = nodes.getJSONObject(i).optString("name", "")

    /** Плотный массив float-компонент аксессора (только FLOAT, как у позиций и клипов). */
    fun floats(accessor: Int): FloatArray {
        val a = accessors.getJSONObject(accessor)
        require(a.getInt("componentType") == 5126) { "аксессор $accessor не float" }
        val per = mapOf("SCALAR" to 1, "VEC2" to 2, "VEC3" to 3, "VEC4" to 4, "MAT4" to 16).getValue(a.getString("type"))
        val count = a.getInt("count")
        val v = views.getJSONObject(a.getInt("bufferView"))
        val buf = buffers[v.getInt("buffer")].duplicate().order(ByteOrder.LITTLE_ENDIAN)
        val base = v.optInt("byteOffset", 0) + a.optInt("byteOffset", 0)
        val stride = v.optInt("byteStride", per * 4)
        return FloatArray(count * per) { k -> buf.getFloat(base + (k / per) * stride + (k % per) * 4) }
    }

    /** Узлы с мешами и их POSITION — по всем примитивам. */
    fun meshPositions(): List<Pair<Int, FloatArray>> {
        val meshes = json.optJSONArray("meshes") ?: return emptyList()
        val out = ArrayList<Pair<Int, FloatArray>>()
        for (i in 0 until nodes.length()) {
            val mesh = nodes.getJSONObject(i).optInt("mesh", -1)
            if (mesh < 0) continue
            val prims = meshes.getJSONObject(mesh).getJSONArray("primitives")
            for (p in 0 until prims.length()) {
                val pos = prims.getJSONObject(p).getJSONObject("attributes").optInt("POSITION", -1)
                if (pos >= 0) out.add(i to floats(pos))
            }
        }
        return out
    }

    class Track(val node: Int, val path: String, val times: FloatArray, val values: FloatArray)

    fun tracks(anim: Int = 0): List<Track> {
        val a = json.optJSONArray("animations")?.optJSONObject(anim) ?: return emptyList()
        val samplers = a.getJSONArray("samplers")
        val channels = a.getJSONArray("channels")
        return List(channels.length()) { i ->
            val c = channels.getJSONObject(i)
            val s = samplers.getJSONObject(c.getInt("sampler"))
            val target = c.getJSONObject("target")
            Track(target.optInt("node", -1), target.getString("path"), floats(s.getInt("input")), floats(s.getInt("output")))
        }
    }

    /** Картинка baseColor первого материала — заводская текстура готовой рыбки. */
    fun baseColorImage(): String? {
        val mat = json.optJSONArray("materials")?.optJSONObject(0) ?: return null
        val tex = mat.optJSONObject("pbrMetallicRoughness")?.optJSONObject("baseColorTexture") ?: return null
        val src = json.getJSONArray("textures").getJSONObject(tex.getInt("index")).optInt("source", -1)
        if (src < 0) return null
        return json.getJSONArray("images").getJSONObject(src).optString("uri").ifEmpty { null }
    }

    companion object {
        fun read(json: ByteBuffer, open: (String) -> ByteBuffer): Gltf {
            val text = ByteArray(json.remaining()).also { json.duplicate().get(it) }.toString(Charsets.UTF_8)
            val j = JSONObject(text)
            val bufs = j.optJSONArray("buffers") ?: JSONArray()
            return Gltf(j, List(bufs.length()) { open(bufs.getJSONObject(it).getString("uri")) })
        }
    }
}
