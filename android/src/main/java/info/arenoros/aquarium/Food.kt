package info.arenoros.aquarium

import android.opengl.Matrix
import com.google.android.filament.Box
import com.google.android.filament.Engine
import com.google.android.filament.EntityManager
import com.google.android.filament.IndexBuffer
import com.google.android.filament.Material
import com.google.android.filament.RenderableManager
import com.google.android.filament.Scene
import com.google.android.filament.VertexBuffer
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.round
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.random.Random

// Корм — feedNow/updateFoods сайта: гранулы сыплются сверху, медленно тонут,
// рыбки плывут к ближайшей и съедают; ушедшее ниже досягаемости тает.
class Food(private val engine: Engine, private val scene: Scene, material: Material) {
    class Grain(val entity: Int, val pos: FloatArray, val seed: Float, val sink: Float, var gone: Float = 0f)

    private val grains = ArrayList<Grain>()
    val count get() = grains.size
    private val mi = material.createInstance().apply {
        // 0xd2913f при свете сцены + emissive 0x63421a × 0.6
        setParameter("color", 0.97f, 0.67f, 0.28f)
    }
    private val vb: VertexBuffer
    private val ib: IndexBuffer
    private val indexCount: Int
    private val m = FloatArray(16)
    // gltfio-подобная беда: JNI не держит direct-буфер, пока его не прочёл драйвер
    @Suppress("unused") private val keep: List<ByteBuffer>

    init {
        // SphereGeometry(0.09, 8, 6)
        val seg = 8; val rings = 6; val r = 0.09f
        val pos = ByteBuffer.allocateDirect((seg + 1) * (rings + 1) * 12).order(ByteOrder.nativeOrder())
        for (j in 0..rings) for (i in 0..seg) {
            val th = Math.PI * j / rings; val ph = 2 * Math.PI * i / seg
            pos.putFloat((-r * cos(ph) * sin(th)).toFloat()).putFloat((r * cos(th)).toFloat()).putFloat((r * sin(ph) * sin(th)).toFloat())
        }
        pos.flip()
        val idx = ByteBuffer.allocateDirect(seg * rings * 6 * 2).order(ByteOrder.nativeOrder())
        for (j in 0 until rings) for (i in 0 until seg) {
            val a = j * (seg + 1) + i; val b = a + seg + 1
            for (v in intArrayOf(a, b, a + 1, b, b + 1, a + 1)) idx.putShort(v.toShort())
        }
        idx.flip()
        indexCount = seg * rings * 6
        vb = VertexBuffer.Builder().bufferCount(1).vertexCount((seg + 1) * (rings + 1))
            .attribute(VertexBuffer.VertexAttribute.POSITION, 0, VertexBuffer.AttributeType.FLOAT3, 0, 12)
            .build(engine)
        vb.setBufferAt(engine, 0, pos)
        ib = IndexBuffer.Builder().indexCount(indexCount).bufferType(IndexBuffer.Builder.IndexType.USHORT).build(engine)
        ib.setBuffer(engine, idx)
        keep = listOf(pos, idx)
    }

    fun feed(aspect: Float) {
        // Каждая щепотка своя: кучная падает комком, рассыпчатая разлетается.
        val tight = Random.nextFloat()
        val spreadX = 0.7f + (1 - tight) * 5.0f
        val spreadZ = 0.5f + (1 - tight) * 2.4f
        val n = minOf(round(7 + (1 - tight) * 26 + Random.nextFloat() * 10).toInt(), max(0, FOOD_MAX - grains.size))
        // в ближней половине объёма, по кадру — иначе часть падала бы за краем
        val cz = Space.Z_NEAR - 3 - Random.nextFloat() * ((Space.Z_NEAR - Space.Z_FAR) * 0.45f)
        val cl = Space.limits(cz, aspect, 0f)
        val cx = (Random.nextFloat() * 2 - 1) * max(1f, cl[0] - spreadX - 1)
        repeat(n) {
            val e = EntityManager.get().create()
            RenderableManager.Builder(1)
                .geometry(0, RenderableManager.PrimitiveType.TRIANGLES, vb, ib, 0, indexCount)
                .material(0, mi)
                .boundingBox(Box(0f, 0f, 0f, 0.09f, 0.09f, 0.09f))
                .castShadows(false).receiveShadows(false)
                .build(engine, e)
            scene.addEntity(e)
            grains.add(Grain(e, floatArrayOf(
                cx + (Random.nextFloat() - 0.5f) * spreadX * 2,
                // от верхнего края кадра на этой глубине, разброс по высоте — струйка
                cl[1] - 0.3f - Random.nextFloat() * (0.6f + (1 - tight) * 2.5f),
                cz + (Random.nextFloat() - 0.5f) * spreadZ * 2
            ), Random.nextFloat() * 6.28f, 0.28f + Random.nextFloat() * 0.22f))
        }
    }

    fun update(dt: Float, t: Float, aspect: Float) {
        val tm = engine.transformManager
        for (i in grains.indices.reversed()) {
            val g = grains[i]; val p = g.pos
            p[1] -= g.sink * dt
            p[0] += sin(t * 1.7f + g.seed) * dt * 0.12f
            p[2] += cos(t * 1.3f + g.seed) * dt * 0.09f
            var k = 1f
            // ниже досягаемости рыб гранула тает, а не лежит на полу полминуты
            if (p[1] < Space.limits(p[2], aspect)[2] + FOOD_REACH) {
                g.gone += dt
                k = 1 - g.gone / FOOD_FADE
                if (k <= 0.02f) { eat(i); continue }
            }
            if (p[1] < Space.FLOOR + 0.12f) p[1] = Space.FLOOR + 0.12f
            Matrix.setIdentityM(m, 0)
            Matrix.translateM(m, 0, p[0], p[1], p[2])
            Matrix.scaleM(m, 0, k, k, k)
            tm.setTransform(tm.getInstance(g.entity), m)
        }
    }

    fun nearest(p: FloatArray): Pair<Grain, Float>? {
        var best: Grain? = null; var bestD = Float.MAX_VALUE
        for (g in grains) { val d = dist(p, g.pos); if (d < bestD) { bestD = d; best = g } }
        return best?.let { it to bestD }
    }

    /** Убирает до max гранул в пределах рта; сколько убрала. */
    fun eatNear(p: FloatArray, max: Int): Int {
        var n = 0
        for (i in grains.indices.reversed()) {
            if (n >= max) break
            if (dist(p, grains[i].pos) < EAT_REACH) { eat(i); n++ }
        }
        return n
    }

    private fun eat(i: Int) {
        val g = grains.removeAt(i)
        scene.remove(g.entity)
        engine.destroyEntity(g.entity)
        EntityManager.get().destroy(g.entity)
    }

    private fun dist(a: FloatArray, b: FloatArray): Float {
        val x = a[0] - b[0]; val y = a[1] - b[1]; val z = a[2] - b[2]
        return sqrt(x * x + y * y + z * z)
    }

    companion object {
        const val FOOD_MAX = 220
        const val FOOD_REACH = 0.9f
        const val FOOD_FADE = 3.5f
        const val EAT_REACH = 0.8f
    }
}
