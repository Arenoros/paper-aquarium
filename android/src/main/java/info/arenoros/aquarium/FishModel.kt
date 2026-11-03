package info.arenoros.aquarium

import android.opengl.Matrix
import com.google.android.filament.Engine
import com.google.android.filament.Texture
import com.google.android.filament.gltfio.AssetLoader
import com.google.android.filament.gltfio.FilamentAsset
import com.google.android.filament.gltfio.FilamentInstance
import com.google.android.filament.gltfio.ResourceLoader
import java.nio.ByteBuffer
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.sqrt

// Вид рыбы на сцене: модель из пака, разобранная так же, как на сайте, —
// FishFrame.fromSkeleton, normalizeFish, clipBeatHz и stripRootMotion из
// demos/realistic-tank.html и assets/fish-frame.js. Разбор один на вид,
// экземпляры берутся из пула: удалённая рыбка отдаёт свой следующей.
class FishModel private constructor(
    val name: String,
    /** Длина рыбы этого вида в единицах сцены. */
    val length: Float,
    private val loader: AssetLoader,
    private val near: FilamentAsset,
    private val far: FilamentAsset?,
    /** Модель → «нос в +Z, спина в +Y, длина = length, центр в нуле». */
    val pivot: FloatArray,
    /** Взмахов телом в секунду в клипе как он есть; 0 — тело гнёт шейдер. */
    val beatHz: Float,
    val duration: Float,
    val bend: Bend,
    /** Строки планарной UV раскраски по имени узла меша (uvU, uvV). */
    val planar: Map<String, Pair<FloatArray, FloatArray>>,
    /** Заводская текстура — для готовой рыбки. */
    val baseTexture: Texture?,
    /** Узлы, чья дорожка позиции возит рыбу вперёд: её срезаем, узел стоит в позе привязки. */
    private val pinned: Map<String, FloatArray>,
    /** Буферы glTF: gltfio держит на них ссылки без копии, а createInstance — исходник. */
    @Suppress("unused") private val keep: List<ByteBuffer>,
) {
    class Bend(val body: FloatArray, val lat: FloatArray, val min: Float, val max: Float, val headAtMax: Boolean)

    /** Экземпляр на сцене: ближняя модель и, если есть, дальний LOD. */
    class Body(val near: FilamentInstance, val far: FilamentInstance?, val pins: List<Pin>)
    class Pin(val entity: Int, val rest: FloatArray)   // rest — смещение узла из glTF

    private val pool = ArrayList<Body>()

    init { pool.add(body(near.instance, far?.instance)) }

    fun obtain(): Body = pool.removeLastOrNull()
        ?: body(loader.createInstance(near) ?: error("$name: нет экземпляра"), far?.let { loader.createInstance(it) })

    fun release(b: Body) { pool.add(b) }

    private fun body(n: FilamentInstance, f: FilamentInstance?): Body {
        val pins = listOfNotNull(n, f).flatMap { inst ->
            inst.entities.toList().mapNotNull { e -> pinned[near.getName(e)]?.let { Pin(e, it) } }
        }
        return Body(n, f, pins)
    }

    fun nodeName(e: Int): String? = near.getName(e)

    companion object {
        // Плавники и тело различаем по именам костей: в паке плавники так
        // и названы (Discus1_fin_l_4_tip41), а позвоночник — Bone01…Bone13.
        const val PACK = "web/assets/models/pack/"
        const val PACK_LOD = "web/assets/models/pack-lod1/"
        private val FIN_BONE = Regex("fin|pect|dors|anal|pelv|tip", RegexOption.IGNORE_CASE)

        fun load(
            engine: Engine, loader: AssetLoader, resources: ResourceLoader,
            name: String, length: Float, read: (String) -> ByteBuffer?, texture: (String) -> Texture?,
        ): FishModel? {
            val keep = ArrayList<ByteBuffer>()
            fun open(dir: String): Pair<FilamentAsset, Gltf>? {
                val json = read("$dir$name/$name.gltf") ?: return null
                keep.add(json)
                val gltf = Gltf.read(json) { uri -> read("$dir$name/$uri")!!.also(keep::add) }
                val asset = loader.createInstancedAsset(json, arrayOfNulls(1)) ?: return null
                // ResourceLoader помнит данные по uri, а у LOD они одноимённые
                resources.evictResourceData()
                for (uri in asset.resourceUris) resources.addResourceData(uri, read("$dir$name/$uri")!!.also(keep::add))
                resources.loadResources(asset)
                return asset to gltf
            }
            val (asset, gltf) = open(PACK) ?: return null
            val far = open(PACK_LOD)?.first
            val tm = engine.transformManager

            val skel = fromSkeleton(asset.instance, tm)
            val meshes = gltf.meshPositions()
            val worldPts = meshes.flatMap { (node, p) -> transformed(gltf.world[node], p) }
            val localPts = meshes.flatMap { (_, p) -> points(p) }
            val w = frame(worldPts, skel?.axes)
            val local = frame(localPts, skel?.axes)
            if (skel != null) { w.headAtMax = skel.headAtMax; local.headAtMax = skel.headAtMax }

            // Базис модели обращаем: нос → +Z, спина → +Y (normalizeFish).
            val fwd = axisVec(w.body, if (w.headAtMax) 1f else -1f)
            val up = axisVec(w.up, if (w.dorsalPositive) 1f else -1f)
            val right = cross(up, fwd)
            val rot = floatArrayOf(right[0], up[0], fwd[0], 0f, right[1], up[1], fwd[1], 0f, right[2], up[2], fwd[2], 0f, 0f, 0f, 0f, 1f)
            val scale = length / max(w.size[w.body], 1e-6f)
            val pivot = FloatArray(16)
            Matrix.setIdentityM(pivot, 0)
            Matrix.multiplyMM(pivot, 0, rot, 0, FloatArray(16).also {
                Matrix.setIdentityM(it, 0); Matrix.scaleM(it, 0, scale, scale, scale)
                Matrix.translateM(it, 0, -w.center[0], -w.center[1], -w.center[2])
            }, 0)

            // Планарная UV раскраски — в том же кадре «нос в +Z», что и у сайта
            // (buildPaintedTemplate): u — хвост → нос, v — брюхо → спина.
            val m = FloatArray(16)
            var z0 = Float.MAX_VALUE; var z1 = -Float.MAX_VALUE; var y0 = Float.MAX_VALUE; var y1 = -Float.MAX_VALUE
            val perNode = meshes.map { (node, p) ->
                Matrix.multiplyMM(m, 0, pivot, 0, gltf.world[node], 0)
                for (q in transformed(m, p)) {
                    z0 = minOf(z0, q[2]); z1 = maxOf(z1, q[2]); y0 = minOf(y0, q[1]); y1 = maxOf(y1, q[1])
                }
                node to m.copyOf()
            }
            val sz = max(z1 - z0, 1e-6f); val sy = max(y1 - y0, 1e-6f)
            val planar = perNode.associate { (node, mm) ->
                gltf.nodeName(node) to (floatArrayOf(mm[2], mm[6], mm[10], mm[14] - z0).map { it / sz }.toFloatArray() to
                    floatArrayOf(mm[1], mm[5], mm[9], mm[13] - y0).map { it / sy }.toFloatArray())
            }

            val tracks = gltf.tracks()
            val bodyLen = w.size.max()
            val pinned = tracks.filter { it.path == "translation" && it.node >= 0 && moved(it.values) >= bodyLen * 0.5f }
                .associate { tr ->
                    val n = gltf.nodes.getJSONObject(tr.node)
                    val t = n.optJSONArray("translation")
                    gltf.nodeName(tr.node) to FloatArray(3) { t?.getDouble(it)?.toFloat() ?: 0f }
                }
            val beat = clipBeatHz(tracks.filter { it.path == "rotation" && !FIN_BONE.containsMatchIn(gltf.nodeName(it.node)) })
            val a = asset.instance.animator
            return FishModel(
                name, length, loader, asset, far, pivot, beat,
                if (a.animationCount > 0) max(a.getAnimationDuration(0), 1e-3f) else 1f,
                Bend(axisVec(local.body, 1f), axisVec(local.lat, 1f), local.min[local.body], local.max[local.body], local.headAtMax),
                planar, gltf.baseColorImage()?.let { texture("$PACK$name/$it") }, pinned, keep
            )
        }

        // ── FishFrame.fromSkeleton: оси и голова по взмахам скелета ─────────
        class Axes(val body: Int, val up: Int, val lat: Int)
        class Skel(val axes: Axes, val headAtMax: Boolean)

        private fun fromSkeleton(inst: FilamentInstance, tm: com.google.android.filament.TransformManager): Skel? {
            val anim = inst.animator
            if (anim.animationCount == 0 || inst.skinCount == 0) return null
            val bones = inst.getJointsAt(0)
            if (bones.size < 3) return null
            val dur = anim.getAnimationDuration(0).takeIf { it > 0 } ?: 1f
            val m = FloatArray(16)
            val snaps = listOf(0f, 0.2f, 0.4f, 0.6f, 0.8f).map { f ->
                anim.applyAnimation(0, f * dur)
                bones.map { b -> tm.getWorldTransform(tm.getInstance(b), m); floatArrayOf(m[12], m[13], m[14]) }
            }
            anim.applyAnimation(0, 0f)

            // Часть клипов вдобавок везёт рыбу вперёд — для выбора осей сдвиг убираем.
            val local = snaps.map { s ->
                val c = FloatArray(3); s.forEach { p -> for (k in 0..2) c[k] += p[k] / s.size }
                s.map { p -> FloatArray(3) { p[it] - c[it] } }
            }
            val spread = FloatArray(3) { a -> local[0].maxOf { it[a] } - local[0].minOf { it[a] } }
            val body = (0..2).maxBy { spread[it] }
            val rest = (0..2).filter { it != body }
            val bLo = local[0].minOf { it[body] }; val bSpan = (local[0].maxOf { it[body] } - bLo).takeIf { it > 0 } ?: 1f

            // Бок — ось, по которой сильнее мотает КОНЦЫ тела.
            fun endSway(a: Int): Float {
                var sLo = 0f; var nLo = 0; var sHi = 0f; var nHi = 0
                local[0].forEachIndexed { i, p ->
                    val d = local.maxOf { it[i][a] } - local.minOf { it[i][a] }
                    val along = (p[body] - bLo) / bSpan
                    if (along < 0.25f) { sLo += d; nLo++ } else if (along > 0.75f) { sHi += d; nHi++ }
                }
                return max(sLo / max(nLo, 1), sHi / max(nHi, 1))
            }
            val lat = if (endSway(rest[0]) >= endSway(rest[1])) rest[0] else rest[1]
            val up = if (rest[0] == lat) rest[1] else rest[0]

            // Голова — где меньше мотает вбок; здесь исходные положения, без вычитания сдвига.
            val lo0 = snaps[0].minOf { it[body] }; val span = (snaps[0].maxOf { it[body] } - lo0).takeIf { it > 0 } ?: 1f
            var sLow = 0f; var nLow = 0; var sHigh = 0f; var nHigh = 0
            snaps[0].forEachIndexed { i, p ->
                val along = (p[body] - lo0) / span
                val d = snaps.maxOf { it[i][lat] } - snaps.minOf { it[i][lat] }
                if (along < 0.4f) { sLow += d; nLow++ } else if (along > 0.6f) { sHigh += d; nHigh++ }
            }
            if (nLow == 0 || nHigh == 0) return null
            return Skel(Axes(body, up, lat), sHigh / nHigh < sLow / nLow)
        }

        // ── fishFrame сайта: габарит, центр масс, голова по толщине ─────────
        class Frame(
            val min: FloatArray, val max: FloatArray, val size: FloatArray, val center: FloatArray,
            val body: Int, val up: Int, val lat: Int, var headAtMax: Boolean, val dorsalPositive: Boolean,
        )

        private fun frame(pts: List<FloatArray>, axes: Axes?): Frame {
            val mn = FloatArray(3) { a -> pts.minOf { it[a] } }
            val mx = FloatArray(3) { a -> pts.maxOf { it[a] } }
            val size = FloatArray(3) { mx[it] - mn[it] }
            val center = FloatArray(3) { (mx[it] + mn[it]) / 2 }
            val centroid = FloatArray(3) { a -> pts.sumOf { it[a].toDouble() }.toFloat() / max(pts.size, 1) }
            val order = (0..2).sortedByDescending { size[it] }
            val body = axes?.body ?: order[0]; val up = axes?.up ?: order[1]; val lat = axes?.lat ?: order[2]
            val span = size[body].takeIf { it > 0 } ?: 1f
            var thickLow = 0f; var thickHigh = 0f
            for (v in pts) {
                val t = (v[body] - mn[body]) / span
                val lateral = abs(v[lat] - center[lat])
                if (t < 0.18f) thickLow = max(thickLow, lateral) else if (t > 0.82f) thickHigh = max(thickHigh, lateral)
            }
            // FishFrame.dorsalPositive: glTF авторится «Y вверх» — если ось «вверх» Y, верим этому.
            val dorsal = if (up == 1) true else centroid[up] < center[up]
            return Frame(mn, mx, size, center, body, up, lat, thickHigh > thickLow, dorsal)
        }

        // ── clipBeatHz: сколько взмахов телом в секунду в клипе как он есть ──
        private fun clipBeatHz(tracks: List<Gltf.Track>): Float {
            var best = 0f; var bestSpan = 0f
            for (tr in tracks) {
                val n = tr.values.size / 4
                if (n < 4) continue
                for (c in 0 until 3) {
                    var lo = Float.MAX_VALUE; var hi = -Float.MAX_VALUE; var sum = 0f
                    for (i in 0 until n) { val x = tr.values[i * 4 + c]; lo = minOf(lo, x); hi = maxOf(hi, x); sum += x }
                    val spanC = hi - lo
                    if (spanC <= bestSpan) continue
                    val mean = sum / n
                    var cross = 0
                    for (j in 1 until n) if ((tr.values[(j - 1) * 4 + c] - mean) * (tr.values[j * 4 + c] - mean) < 0) cross++
                    val dur = tr.times.last().takeIf { it != 0f } ?: 1f
                    bestSpan = spanC
                    best = cross / 2f / dur
                }
            }
            return if (best > 0.05f) best else 0f
        }

        private fun moved(v: FloatArray): Float {
            val lo = FloatArray(3) { Float.MAX_VALUE }; val hi = FloatArray(3) { -Float.MAX_VALUE }
            for (i in 0 until v.size / 3) for (c in 0..2) { lo[c] = minOf(lo[c], v[i * 3 + c]); hi[c] = maxOf(hi[c], v[i * 3 + c]) }
            return sqrt((0..2).sumOf { ((hi[it] - lo[it]) * (hi[it] - lo[it])).toDouble() }).toFloat()
        }

        private fun points(p: FloatArray) = List(p.size / 3) { floatArrayOf(p[it * 3], p[it * 3 + 1], p[it * 3 + 2]) }

        private fun transformed(m: FloatArray, p: FloatArray): List<FloatArray> {
            val v = FloatArray(4); val o = FloatArray(4)
            return List(p.size / 3) {
                v[0] = p[it * 3]; v[1] = p[it * 3 + 1]; v[2] = p[it * 3 + 2]; v[3] = 1f
                Matrix.multiplyMV(o, 0, m, 0, v, 0)
                floatArrayOf(o[0], o[1], o[2])
            }
        }

        private fun axisVec(a: Int, sign: Float) = FloatArray(3) { if (it == a) sign else 0f }
        private fun cross(a: FloatArray, b: FloatArray) =
            floatArrayOf(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])
    }
}
