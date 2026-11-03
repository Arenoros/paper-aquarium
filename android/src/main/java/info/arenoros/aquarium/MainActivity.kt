package info.arenoros.aquarium

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.TypedValue
import android.view.Choreographer
import android.view.Gravity
import android.view.KeyEvent
import android.view.Surface
import android.view.SurfaceView
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import com.google.android.filament.Engine
import com.google.android.filament.Filament
import com.google.android.filament.Renderer
import com.google.android.filament.SwapChain
import com.google.android.filament.SwapChainFlags
import com.google.android.filament.android.DisplayHelper
import com.google.android.filament.android.UiHelper
import com.google.android.filament.gltfio.Gltfio
import java.io.File
import kotlin.math.min

// ТВ-приложение: аквариум на весь экран. Сцена — Aquarium, данные — папка
// files/tank в формате server.js, рыбок присылают телефоны через встроенный
// TankServer (docs/adr/0001, 0002). Пульт: OK — QR для телефона, «Назад» —
// спрятать QR или выйти.
//   adb shell am start -n info.arenoros.aquarium/.MainActivity --ez feed true   — покормить
class MainActivity : Activity(), Choreographer.FrameCallback {
    companion object { init { Filament.init(); Gltfio.init() } }

    private lateinit var surface: SurfaceView
    private lateinit var ui: UiHelper
    private lateinit var display: DisplayHelper
    private lateinit var engine: Engine
    private lateinit var renderer: Renderer
    private lateinit var aquarium: Aquarium
    private lateinit var store: TankStore
    private var swapChain: SwapChain? = null
    private var server: TankServer? = null
    private val choreographer = Choreographer.getInstance()
    private val handler = Handler(Looper.getMainLooper())

    private lateinit var qrPanel: LinearLayout
    private lateinit var qrImage: ImageView
    private lateinit var qrUrl: TextView
    private lateinit var hint: TextView

    // Сервер пишет на диск из своих потоков, сцена живёт в главном.
    private val events = object : TankServer.Events {
        override fun fishChanged() { handler.post { aquarium.sync() } }
        override fun settingsChanged() { handler.post { aquarium.sync() } }
        override fun feed() { handler.post { aquarium.feed() } }
    }

    private var t0 = 0L
    private var lastT = 0.0
    private var frames = 0
    private var statAt = 0.0

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        surface = SurfaceView(this)
        val root = FrameLayout(this)
        root.addView(surface)
        buildOverlay(root)
        setContentView(root)

        engine = Engine.create()
        renderer = engine.createRenderer()
        renderer.setClearOptions(Renderer.ClearOptions().apply { clear = true; setClearColor(0.0047, 0.0052, 0.0065, 1.0) })
        store = TankStore(File(filesDir, "tank"))
        aquarium = Aquarium(this, engine, store)

        display = DisplayHelper(this)
        ui = UiHelper(UiHelper.ContextErrorPolicy.DONT_CHECK)
        ui.setRenderCallback(object : UiHelper.RendererCallback {
            override fun onNativeWindowChanged(s: Surface) {
                swapChain?.let { engine.destroySwapChain(it) }
                // MSAA 4× у самой поверхности EGL: на тайловом Mali сэмплы живут
                // в памяти тайла. MSAA вида Filament гонит их через память и
                // съедал половину кадра (docs/adr/0002).
                val msaa = if (SwapChain.isMSAASwapChainSupported(engine, 4)) SwapChainFlags.CONFIG_MSAA_4_SAMPLES else 0L
                swapChain = engine.createSwapChain(s, ui.swapChainFlags or msaa)
                display.attach(renderer, surface.display)
            }
            override fun onDetachedFromSurface() {
                display.detach()
                swapChain?.let { engine.destroySwapChain(it); engine.flushAndWait() }
                swapChain = null
            }
            override fun onResized(w: Int, h: Int) = aquarium.resize(w, h)
        })
        // 1080p: интерфейс ТВ и так 1920×1080, панель 4K растягивает сама.
        ui.setDesiredSize(1920, 1080)
        ui.attachTo(surface)

        aquarium.sync()
        // Пустой аквариум сразу показывает, как в него попасть; иначе — подсказка про OK.
        if (aquarium.fishCount == 0) showQr() else flashHint()
        onNewIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.getBooleanExtra("feed", false)) aquarium.feed()
    }

    // Сервер живёт, пока аквариум на экране (ADR 0001): выключенный ТВ рыбок
    // не принимает, а страница съёмки предлагает «Отправить снова».
    override fun onStart() {
        super.onStart()
        server = runCatching {
            TankServer(assets, store, aquarium.kinds, events).apply { start(5000, false) }
        }.onFailure { Log.e("aqua", "сервер не поднялся на ${TankServer.PORT}", it) }.getOrNull()
        aquarium.sync()   // пока нас не было, мог смениться фон или список
    }

    override fun onStop() {
        server?.stop()
        server = null
        super.onStop()
    }

    override fun onResume() { super.onResume(); choreographer.postFrameCallback(this) }
    override fun onPause() { choreographer.removeFrameCallback(this); super.onPause() }

    override fun onDestroy() {
        ui.detach()
        engine.destroy()
        super.onDestroy()
    }

    // ── пульт ───────────────────────────────────────────────────────────────
    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean = when (keyCode) {
        KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER, KeyEvent.KEYCODE_BUTTON_A -> {
            if (qrPanel.visibility == View.VISIBLE) hideQr() else showQr()
            true
        }
        KeyEvent.KEYCODE_BACK -> if (qrPanel.visibility == View.VISIBLE) { hideQr(); true } else super.onKeyDown(keyCode, event)
        else -> super.onKeyDown(keyCode, event)
    }

    private fun showQr() {
        val url = Qr.tankUrl()
        if (url != null) {
            qrImage.setImageBitmap(Qr.bitmap(url, 480))
            qrImage.visibility = View.VISIBLE
            qrUrl.text = url
        } else {
            qrImage.visibility = View.GONE
            qrUrl.text = getString(R.string.no_network)
        }
        hint.visibility = View.GONE
        qrPanel.visibility = View.VISIBLE
    }

    private fun hideQr() { qrPanel.visibility = View.GONE }

    private fun flashHint() {
        hint.visibility = View.VISIBLE
        handler.postDelayed({ hint.visibility = View.GONE }, 10_000)
    }

    private fun buildOverlay(root: FrameLayout) {
        fun text(sp: Float, bold: Boolean = false) = TextView(this).apply {
            setTextColor(Color.WHITE); setTextSize(TypedValue.COMPLEX_UNIT_SP, sp); gravity = Gravity.CENTER
            if (bold) typeface = Typeface.DEFAULT_BOLD
        }
        qrImage = ImageView(this)
        qrUrl = text(16f).apply { typeface = Typeface.MONOSPACE; setPadding(0, 16, 0, 8) }
        val wide = { LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT) }
        qrPanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(48, 40, 48, 40)
            background = GradientDrawable().apply { setColor(0xD9101820.toInt()); cornerRadius = 32f }
            addView(text(26f, bold = true).apply { setText(R.string.qr_title); setPadding(0, 0, 0, 24) }, wide())
            addView(qrImage, LinearLayout.LayoutParams(360, 360))
            addView(qrUrl, wide())
            addView(text(16f).apply { setText(R.string.qr_sub); alpha = 0.8f }, wide())
            visibility = View.GONE
        }
        // ширина явная: в WRAP_CONTENT подписи резались по ширине QR
        root.addView(qrPanel, FrameLayout.LayoutParams(960,
            FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
        hint = text(18f).apply {
            setText(R.string.hint_ok)
            setPadding(32, 14, 32, 14)
            background = GradientDrawable().apply { setColor(0x99101820.toInt()); cornerRadius = 40f }
            visibility = View.GONE
        }
        root.addView(hint, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT,
            FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL).apply { bottomMargin = 48 })
    }

    // ── цикл ────────────────────────────────────────────────────────────────
    override fun doFrame(frameTimeNanos: Long) {
        choreographer.postFrameCallback(this)
        if (t0 == 0L) t0 = frameTimeNanos
        val t = (frameTimeNanos - t0) / 1e9
        val dt = min(t - lastT, 0.05).toFloat()
        lastT = t
        aquarium.update(t.toFloat(), dt)

        val sc = swapChain ?: return
        if (ui.isReadyToRender && renderer.beginFrame(sc, frameTimeNanos)) {
            renderer.render(aquarium.view)
            renderer.endFrame()
            frames++
        }
        if (t - statAt >= 5.0) {
            Log.i("aqua", "fps %.1f".format(frames / (t - statAt)))
            frames = 0; statAt = t
        }
    }
}
