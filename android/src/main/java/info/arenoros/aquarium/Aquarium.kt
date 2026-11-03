package info.arenoros.aquarium

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.google.android.filament.Camera
import com.google.android.filament.Engine
import com.google.android.filament.EntityManager
import com.google.android.filament.IndexBuffer
import com.google.android.filament.MaterialInstance
import com.google.android.filament.RenderableManager
import com.google.android.filament.Texture
import com.google.android.filament.TextureSampler
import com.google.android.filament.VertexBuffer
import com.google.android.filament.View
import com.google.android.filament.Viewport
import com.google.android.filament.android.TextureHelper
import com.google.android.filament.gltfio.AssetLoader
import com.google.android.filament.gltfio.FilamentInstance
import com.google.android.filament.gltfio.ResourceLoader
import com.google.android.filament.gltfio.UbershaderProvider
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.random.Random

// Сцена аквариума: то, что на сайте делает demos/realistic-tank.html, —
// фон, рыбки из папки аквариума, корм. Рыб с диска сводим с тем, что
// плавает: новых подселяем, пропавших убираем (applyPainted сайта).
class Aquarium(private val ctx: Context, private val engine: Engine, private val store: TankStore) {
    val view: View = engine.createView()
    private val scene = engine.createScene()
    private val camera: Camera = engine.createCamera(EntityManager.get().create())
    private val materials = Materials(ctx, engine)
    private val food: Food
    private val loader = AssetLoader(engine, UbershaderProvider(engine), EntityManager.get())
    private val resources = ResourceLoader(engine)
    private val models = HashMap<String, FishModel?>()
    private val fishes = LinkedHashMap<String, Fish>()
    private val outfits = HashMap<FishModel.Body, HashMap<Boolean, List<Slot>>>()
    /** Вид → длина из манифеста раскрасок: единственный список видов. */
    private val lengths: Map<String, Float>
    /** Виды, у которых есть лист раскраски, — их принимает сервер. */
    val kinds: Set<String> get() = lengths.keys
    private val sampler = TextureSampler(TextureSampler.MinFilter.LINEAR_MIPMAP_LINEAR,
        TextureSampler.MagFilter.LINEAR, TextureSampler.WrapMode.CLAMP_TO_EDGE)
    private val main = Handler(Looper.getMainLooper())
    private val blank: Texture
    var aspect = 16f / 9f
        private set

    private class Slot(val ri: Int, val prim: Int, val mi: MaterialInstance)
    /** Записи, которые не вышло подселить (нет вида, битый рисунок): не пробуем каждый раз. */
    private val skipped = HashSet<String>()
    // JNI не держит direct-буфер, пока его не прочёл драйвер (SIGSEGV в
    // memcpy libGLES_mali) — мелочь держим всю жизнь сцены.
    private val keep = ArrayList<ByteBuffer>()
    private val bgMi = materials.background.createInstance()
    private var bgName: String? = null
    private var bgTex: Texture? = null
    private var bgImageAspect = 16f / 9f
    private var bgHalf = floatArrayOf(1f, 1f)

    init {
        view.setScene(scene)
        view.setCamera(camera)
        // Один проход, как у three.js: свет, туман и ACES — в шейдерах,
        // MSAA — у поверхности EGL (см. MainActivity).
        view.setPostProcessingEnabled(false)
        view.setMultiSampleAntiAliasingOptions(View.MultiSampleAntiAliasingOptions().apply { enabled = false })
        camera.lookAt(0.0, Space.CAM_Y.toDouble(), Space.CAM_Z.toDouble(), 0.0, Space.CAM_Y.toDouble(), 0.0, 0.0, 1.0, 0.0)
        camera.setExposure(1f)   // экспозицию сайта (0.92) применяет шейдер

        val manifest = JSONObject(ctx.assets.open("web/assets/coloring/manifest.json").use { it.readBytes().toString(Charsets.UTF_8) })
        val list = manifest.getJSONArray("fish")
        lengths = (0 until list.length()).associate { list.getJSONObject(it).let { f -> f.getString("name") to f.getDouble("length").toFloat() } }

        blank = Texture.Builder().width(1).height(1).levels(1).sampler(Texture.Sampler.SAMPLER_2D)
            .format(Texture.InternalFormat.RGBA8).build(engine)
        val px = ByteBuffer.allocateDirect(4).put(byteArrayOf(-1, -1, -1, -1)).flip() as ByteBuffer
        blank.setImage(engine, 0, Texture.PixelBufferDescriptor(px, Texture.Format.RGBA, Texture.Type.UBYTE))
        keep.add(px)

        food = Food(engine, scene, materials.food)
        buildBackground()
    }

    fun resize(w: Int, h: Int) {
        aspect = w.toFloat() / h
        view.setViewport(Viewport(0, 0, w, h))
        camera.setProjection(Space.FOV, aspect.toDouble(), 0.1, 300.0, Camera.Fov.VERTICAL)
        fitBackground()
    }

    fun feed() = food.feed(aspect)

    fun update(t: Float, dt: Float) {
        spawnNext()
        food.update(dt, t, aspect)
        val tm = engine.transformManager
        for (f in fishes.values) if (f.update(dt, t, aspect, food, tm)) {
            show(f.body.near, !f.far); f.body.far?.let { show(it, f.far) }
        }
    }

    // ── рыбки с диска ───────────────────────────────────────────────────────
    fun sync() {
        applyBackground(store.background() ?: randomBackground().also(store::setBackground))
        val list = store.fish()
        val alive = list.mapTo(HashSet()) { it.id }
        fishes.keys.filter { it !in alive }.forEach(::remove)
        pending.removeAll { it.id !in alive }
        val queued = pending.mapTo(HashSet()) { it.id }
        for (rec in list) if (rec.id !in fishes && rec.id !in skipped && rec.id !in queued) pending.add(rec)
    }

    // Подселяем по одной рыбке за кадр: рисунок, mipmap и первая модель вида —
    // это десятки миллисекунд, и 40 рыбок разом держали первый кадр 8 секунд.
    private val pending = ArrayDeque<TankStore.Rec>()

    private fun spawnNext() {
        val rec = pending.removeFirstOrNull() ?: return
        if (fishes.size < MAX_FISH && !spawn(rec)) skipped.add(rec.id)
    }

    private fun spawn(rec: TankStore.Rec): Boolean {
        val painted = rec.pack == null
        val name = if (painted) LEGACY_KIND[rec.kind] ?: rec.kind else rec.pack!!
        if (painted && name !in lengths) { Log.w("aqua", "нет шаблона для вида ${rec.kind} — рыбка пропущена"); return false }
        val model = models.getOrPut(name) {
            runCatching {
                FishModel.load(engine, loader, resources, name, lengths[name] ?: PACK_LEN, ::readAsset) { path ->
                    readAsset(path)?.let { b -> BitmapFactory.decodeByteArray(ByteArray(b.remaining()).also { b.get(it) }, 0, b.limit()) }
                        ?.let { texture(it) }
                }
            }.onFailure { Log.e("aqua", "модель $name не загрузилась", it) }.getOrNull()
        } ?: return false
        val tex = if (painted) BitmapFactory.decodeFile(store.texture(rec.id).path)?.let { texture(it) } ?: return false
                  else model.baseTexture ?: blank
        val body = model.obtain()
        val phase = Random.nextFloat() * 6.28f
        // Тело гнём сами, если его не гнёт клип (beatHz = 0, см. clipBeatHz).
        val mis = dress(model, body, painted, tex, phase, if (model.beatHz > 0) 0f else 0.35f)
        show(body.near, true); body.far?.let { show(it, false) }
        scene.addEntities(body.near.entities)
        body.far?.let { scene.addEntities(it.entities) }
        val speed = if (painted) 1.7f else 1.2f + Random.nextFloat() * 0.6f
        val len = if (painted) lengths.getValue(name) else model.length
        fishes[rec.id] = Fish(rec.id, model, body, len, speed, mis, if (painted) tex else null, aspect, phase)
        return true
    }

    private fun remove(id: String) {
        val f = fishes.remove(id) ?: return
        scene.removeEntities(f.body.near.entities)
        f.body.far?.let { scene.removeEntities(it.entities) }
        // рисунок отвязываем от материала раньше, чем стираем
        for (mi in f.mis) mi.setParameter("baseColorMap", blank, sampler)
        f.texture?.let(engine::destroyTexture)
        f.model.release(f.body)
    }

    // Материалы экземпляра создаются один раз на «раскрашенную» и «готовую»
    // одёжку: экземпляр из пула может достаться рыбке другой породы.
    private fun dress(model: FishModel, body: FishModel.Body, painted: Boolean, tex: Texture, phase: Float, amp: Float): List<MaterialInstance> {
        val rm = engine.renderableManager
        val slots = outfits.getOrPut(body) { HashMap() }.getOrPut(painted) {
            listOfNotNull(body.near, body.far).flatMap { inst ->
                inst.entities.filter(rm::hasComponent).flatMap { e ->
                    val ri = rm.getInstance(e)
                    val uv = model.planar[model.nodeName(e)] ?: model.planar.values.firstOrNull()
                    List(rm.getPrimitiveCount(ri)) { p ->
                        val mi = (if (painted) materials.painted else materials.textured).createInstance()
                        if (painted && uv != null) {
                            mi.setParameter("uvU", uv.first[0], uv.first[1], uv.first[2], uv.first[3])
                            mi.setParameter("uvV", uv.second[0], uv.second[1], uv.second[2], uv.second[3])
                        }
                        val b = model.bend
                        mi.setParameter("bendRange", b.min, b.max, if (b.headAtMax) 1f else 0f, 0f)
                        Slot(ri, p, mi)
                    }
                }
            }
        }
        val b = model.bend
        for (s in slots) {
            rm.setMaterialInstanceAt(s.ri, s.prim, s.mi)
            s.mi.setParameter("baseColorMap", tex, sampler)
            s.mi.setParameter("bodyMask", b.body[0], b.body[1], b.body[2], phase)
            s.mi.setParameter("latMask", b.lat[0], b.lat[1], b.lat[2], amp)
        }
        return slots.map { it.mi }
    }

    private fun show(inst: FilamentInstance, visible: Boolean) {
        val rm = engine.renderableManager
        for (e in inst.entities) if (rm.hasComponent(e)) rm.setLayerMask(rm.getInstance(e), 0x1, if (visible) 0x1 else 0)
    }

    private fun texture(bmp: Bitmap): Texture {
        val tex = Texture.Builder().width(bmp.width).height(bmp.height).levels(0xff)
            .sampler(Texture.Sampler.SAMPLER_2D).format(Texture.InternalFormat.SRGB8_A8)
            .usage(Texture.Usage.DEFAULT or Texture.Usage.GEN_MIPMAPPABLE).build(engine)
        TextureHelper.setBitmap(engine, tex, 0, bmp, main) { bmp.recycle() }
        tex.generateMipmaps(engine)
        return tex
    }

    private fun readAsset(path: String): ByteBuffer? = runCatching {
        val bytes = ctx.assets.open(path).use { it.readBytes() }
        ByteBuffer.allocateDirect(bytes.size).order(ByteOrder.nativeOrder()).put(bytes).flip() as ByteBuffer
    }.getOrNull()

    // ── фон: картинка «cover» на плоскости ближе начала тумана ──────────────
    // Плоскость в 13 от камеры: туман сайта начинается с 14, фон им не тронут.
    // Рисуется первой и без записи глубины — рыбы всегда поверх.
    private fun buildBackground() {
        val d = 13f
        val hh = d * Space.TAN_HALF * 1.02f
        val hw = hh * 3f   // запас по ширине под любой экран
        val z = Space.CAM_Z - d
        val y = Space.CAM_Y
        val vb = ByteBuffer.allocateDirect(4 * 5 * 4).order(ByteOrder.nativeOrder())
        // x, y, z, u, v; v = 0 — низ картинки (TextureHelper кладёт первую строку вниз)
        for (v in listOf(floatArrayOf(-hw, y - hh, z, 0f, 0f), floatArrayOf(hw, y - hh, z, 1f, 0f),
                         floatArrayOf(-hw, y + hh, z, 0f, 1f), floatArrayOf(hw, y + hh, z, 1f, 1f))) v.forEach { vb.putFloat(it) }
        vb.flip()
        val vertices = VertexBuffer.Builder().bufferCount(1).vertexCount(4)
            .attribute(VertexBuffer.VertexAttribute.POSITION, 0, VertexBuffer.AttributeType.FLOAT3, 0, 20)
            .attribute(VertexBuffer.VertexAttribute.UV0, 0, VertexBuffer.AttributeType.FLOAT2, 12, 20)
            .build(engine)
        vertices.setBufferAt(engine, 0, vb)
        val ib = ByteBuffer.allocateDirect(12).order(ByteOrder.nativeOrder())
        shortArrayOf(0, 1, 2, 2, 1, 3).forEach { ib.putShort(it) }
        ib.flip()
        val indices = IndexBuffer.Builder().indexCount(6).bufferType(IndexBuffer.Builder.IndexType.USHORT).build(engine)
        indices.setBuffer(engine, ib)
        keep.add(vb); keep.add(ib)
        bgHalf = floatArrayOf(hw, hh)
        bgMi.setParameter("map", blank, TextureSampler())
        val e = EntityManager.get().create()
        RenderableManager.Builder(1)
            .geometry(0, RenderableManager.PrimitiveType.TRIANGLES, vertices, indices)
            .material(0, bgMi).priority(0).culling(false)
            .castShadows(false).receiveShadows(false)
            .build(engine, e)
        scene.addEntity(e)
    }

    // Имя фона — как у сервера («05-0.png»); на ТВ лежат лёгкие webp тех же картинок.
    private fun applyBackground(name: String) {
        if (name == bgName) return
        val bmp = runCatching { ctx.assets.open(BG_DIR + name.substringBeforeLast('.') + ".webp").use { BitmapFactory.decodeStream(it) } }
            .getOrNull() ?: return
        bgName = name
        bgImageAspect = bmp.width.toFloat() / bmp.height
        val tex = Texture.Builder().width(bmp.width).height(bmp.height).levels(1)
            .sampler(Texture.Sampler.SAMPLER_2D).format(Texture.InternalFormat.SRGB8_A8).build(engine)
        TextureHelper.setBitmap(engine, tex, 0, bmp, main) { bmp.recycle() }
        bgMi.setParameter("map", tex, TextureSampler(TextureSampler.MinFilter.LINEAR, TextureSampler.MagFilter.LINEAR,
            TextureSampler.WrapMode.CLAMP_TO_EDGE))
        bgTex?.let(engine::destroyTexture)
        bgTex = tex
        fitBackground()
    }

    private fun randomBackground(): String =
        ctx.assets.list(BG_DIR.trimEnd('/'))!!.filter { it.endsWith(".webp") }.random().substringBeforeLast('.') + ".png"

    // Режим cover сайта: картинка заполняет кадр, лишнее срезается.
    private fun fitBackground() {
        val visU = (bgHalf[1] * aspect) / bgHalf[0]   // доля ширины плоскости, видимая в кадре
        val (rx, ry) = if (aspect > bgImageAspect) 1f to bgImageAspect / aspect else aspect / bgImageAspect to 1f
        val sx = rx / visU
        bgMi.setParameter("uvFit", sx, ry, 0.5f - 0.5f * sx, (1f - ry) / 2f)
    }

    companion object {
        const val MAX_FISH = 40     // PAINTED_MAX сайта
        // Фоны на ТВ — webp тех же картинок, что PNG в assets/backgrounds сайта.
        const val BG_DIR = "web/assets/backgrounds/webp/"
        const val PACK_LEN = 2.2f   // длина готовой рыбки вида без раскраски
        // Рисунки с прежних моделей (Free3D, из игры убраны) — на похожие виды пака.
        val LEGACY_KIND = mapOf("chromis" to "fusilierfish", "angelfish" to "bluetang",
            "tropical" to "bluecheekbutterflyfish", "perch" to "clowntriggerfish")
    }
}
