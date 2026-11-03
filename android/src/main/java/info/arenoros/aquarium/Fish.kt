package info.arenoros.aquarium

import android.opengl.Matrix
import com.google.android.filament.MaterialInstance
import com.google.android.filament.Texture
import com.google.android.filament.TransformManager
import com.google.android.filament.gltfio.FilamentInstance
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.math.tan
import kotlin.random.Random

// Объём и камера — как в demos/realistic-tank.html: объём повторяет пирамиду
// обзора, а не коробку, рыба разворачивается у самой кромки кадра.
object Space {
    const val Z_NEAR = 6f
    const val Z_FAR = -18f
    const val FLOOR = 0f
    const val FLOOR_ROOM = 0.9f
    const val MARGIN = 1.6f
    const val CAM_Z = 17.5f
    const val CAM_Y = 6.5f
    const val FOV = 42.0
    val TAN_HALF = tan(Math.toRadians(FOV / 2)).toFloat()
    const val BEATS_PER_LENGTH = 0.85f
    /** Дальше этого от камеры рыба меньше ~150 px в длину — хватает и сетки LOD. */
    const val LOD_DIST = 16f

    /** limitsAt(z) сайта: hw, yTop, yBot — кадр плюс MARGIN. */
    fun limits(z: Float, aspect: Float, margin: Float = MARGIN): FloatArray {
        val half = (CAM_Z - z) * TAN_HALF
        return floatArrayOf(half * aspect + margin, CAM_Y + half + margin, max(FLOOR + FLOOR_ROOM, CAM_Y - half - margin))
    }
}

// Одна рыбка: Fish.prototype.update сайта, перенесённый без изменений.
class Fish(
    val id: String,
    val model: FishModel,
    val body: FishModel.Body,
    /** Длина в сцене: у старых видов (LEGACY_KIND) рисунок сидит на чужой модели. */
    private val len: Float,
    baseSpeed: Float,
    val mis: List<MaterialInstance>,
    /** Свой рисунок раскрашенной рыбки — уходит вместе с ней. */
    val texture: Texture?,
    aspect: Float,
    /** Своя фаза блуждания и изгиба — её же получил материал. */
    val phase: Float,
) {
    private val pos = FloatArray(3)
    private val vel = FloatArray(3)
    private val speed = baseSpeed * (0.85f + Random.nextFloat() * 0.3f)
    // Голод: с какого расстояния видит корм — у каждой свой, чтобы стая не
    // срывалась к еде одновременно; до какой секунды сыта после гранулы.
    private val noticeFood = 6 + Random.nextFloat() * 6
    private var fullUntil = 0f
    private var anim = Random.nextFloat() * 2   // рассинхронизируем взмахи
    var far = false
        private set
    private val m = FloatArray(16)
    private val t16 = FloatArray(16)

    init {
        // Рождаемся сразу внутри объёма на своей глубине.
        val z0 = Space.Z_FAR + Random.nextFloat() * (Space.Z_NEAR - Space.Z_FAR)
        val l0 = Space.limits(z0, aspect)
        val inX = max(0.5f, l0[0] - Space.MARGIN)
        val inLo = l0[2] + Space.MARGIN
        val inHi = l0[1] - Space.MARGIN
        pos[0] = (Random.nextFloat() * 2 - 1) * inX
        pos[1] = inLo + Random.nextFloat() * max(0.5f, inHi - inLo)
        pos[2] = z0
        val vx = Random.nextFloat() - 0.5f; val vz = Random.nextFloat() - 0.5f
        val l = max(sqrt(vx * vx + vz * vz), 1e-4f)
        vel[0] = vx / l * baseSpeed; vel[2] = vz / l * baseSpeed
    }

    val instance: FilamentInstance get() = if (far) body.far!! else body.near

    /** Возвращает true, если сменился LOD — сцене надо переключить видимость. */
    fun update(dt: Float, t: Float, aspect: Float, food: Food, tm: TransformManager): Boolean {
        val a = floatArrayOf(sin(t * 0.42f + phase) * 0.5f, sin(t * 0.3f + phase * 1.6f) * 0.22f, cos(t * 0.37f + phase) * 0.5f)

        // Корм: плывём к ближайшей грануле, вплотную — съедаем. Замечаем
        // только то, что рядом; наевшись, какое-то время не реагируем.
        if (food.count > 0 && t > fullUntil) {
            val g = food.nearest(pos)
            if (g != null && g.second < noticeFood) {
                if (g.second < Food.EAT_REACH) {
                    // за один заход — от одной до трёх гранул, сколько оказалось у рта
                    food.eatNear(pos, 1 + Random.nextInt(3))
                    fullUntil = t + 2.5f + Random.nextFloat() * 8
                } else {
                    val gp = g.first.pos
                    val k = (if (g.second < 6) 4.5f else 2.2f) / g.second
                    for (i in 0..2) a[i] += (gp[i] - pos[i]) * k
                }
            }
        }

        val mg = Space.MARGIN
        val w = 5f
        if (pos[2] > Space.Z_NEAR - mg) a[2] -= w
        if (pos[2] < Space.Z_FAR + mg) a[2] += w
        // Границу держим для ЦЕНТРА рыбы: туловище наполовину уходит за кромку —
        // аквариум читается как окно в риф побольше, а не как коробка.
        val lim = Space.limits(pos[2], aspect)
        if (pos[0] > lim[0] - mg) a[0] -= w
        if (pos[0] < -lim[0] + mg) a[0] += w
        if (pos[1] > lim[1] - mg) a[1] -= w
        if (pos[1] < lim[2] + mg) a[1] += w
        val floor = Space.FLOOR + Space.FLOOR_ROOM
        if (pos[1] < floor) a[1] += (floor - pos[1]) * 4

        for (i in 0..2) vel[i] += a[i] * dt * 2f
        val sp = sqrt(vel[0] * vel[0] + vel[1] * vel[1] + vel[2] * vel[2])
        if (sp > speed) for (i in 0..2) vel[i] *= speed / sp
        if (sp < speed * 0.35f) for (i in 0..2) vel[i] *= 1.05f
        for (i in 0..2) pos[i] += vel[i] * dt

        // LOD — с запасом, чтобы на границе рыба не мигала.
        var switched = false
        if (body.far != null) {
            val d = Space.CAM_Z - pos[2]
            val want = if (far) d > Space.LOD_DIST - 1f else d > Space.LOD_DIST + 1f
            if (want != far) { far = want; switched = true }
        }

        place(t, tm)

        // Темп клипа — от пути: примерно один взмах на корпус длины. Если клип
        // шевелит только плавники (тело гнёт шейдер), темп мягко от скорости.
        val v = sqrt(vel[0] * vel[0] + vel[1] * vel[1] + vel[2] * vel[2])
        val scale = if (model.beatHz > 0) Space.BEATS_PER_LENGTH * v / len / model.beatHz else 0.6f + v / speed * 0.6f
        anim += dt * scale.coerceIn(0.25f, 2f)
        val inst = instance
        val animator = inst.animator
        if (animator.animationCount > 0) {
            animator.applyAnimation(0, anim % model.duration)
            for (p in body.pins) {
                val ti = tm.getInstance(p.entity)
                tm.getTransform(ti, t16)
                t16[12] = p.rest[0]; t16[13] = p.rest[1]; t16[14] = p.rest[2]
                tm.setTransform(ti, t16)
            }
            animator.updateBoneMatrices()
        }
        return switched
    }

    // mesh.lookAt(pos + vel) и лёгкий крен rotation.z += sin(t·2.5 + фаза)·0.015.
    private fun place(t: Float, tm: TransformManager) {
        val sp = max(sqrt(vel[0] * vel[0] + vel[1] * vel[1] + vel[2] * vel[2]), 1e-5f)
        val fx = vel[0] / sp; val fy = vel[1] / sp; val fz = vel[2] / sp
        // x = up × z; при вертикальной скорости up меняем, как Matrix4.lookAt
        var rx = fz; var ry = 0f; var rz = -fx
        var rl = sqrt(rx * rx + rz * rz)
        if (rl < 1e-4f) { rx = 1f; rz = 0f; rl = 1f }
        rx /= rl; rz /= rl
        val ux = fy * rz - fz * ry; val uy = fz * rx - fx * rz; val uz = fx * ry - fy * rx
        val look = floatArrayOf(rx, ry, rz, 0f, ux, uy, uz, 0f, fx, fy, fz, 0f, pos[0], pos[1], pos[2], 1f)
        Matrix.rotateM(look, 0, Math.toDegrees((sin(t * 2.5f + phase) * 0.015f).toDouble()).toFloat(), 0f, 0f, 1f)
        val s = len / model.length
        Matrix.scaleM(look, 0, s, s, s)
        Matrix.multiplyMM(m, 0, look, 0, model.pivot, 0)
        tm.setTransform(tm.getInstance(instance.root), m)
    }
}
