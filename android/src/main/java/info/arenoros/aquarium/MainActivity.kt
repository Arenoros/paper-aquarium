package info.arenoros.aquarium

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Choreographer
import android.view.Surface
import android.view.SurfaceView
import android.view.WindowManager
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
// files/tank в формате server.js (docs/adr/0001, 0002).
//   adb shell am start -n info.arenoros.aquarium/.MainActivity --ez feed true   — покормить
class MainActivity : Activity(), Choreographer.FrameCallback {
    companion object { init { Filament.init(); Gltfio.init() } }

    private lateinit var surface: SurfaceView
    private lateinit var ui: UiHelper
    private lateinit var display: DisplayHelper
    private lateinit var engine: Engine
    private lateinit var renderer: Renderer
    private lateinit var aquarium: Aquarium
    private var swapChain: SwapChain? = null
    private val choreographer = Choreographer.getInstance()
    private val handler = Handler(Looper.getMainLooper())

    // ponytail: сверка с диском раз в 2 с; когда появится встроенный сервер,
    // он будет звать sync() сам, и опрос уйдёт.
    private val syncTick = object : Runnable {
        override fun run() { aquarium.sync(); handler.postDelayed(this, 2000) }
    }

    private var t0 = 0L
    private var lastT = 0.0
    private var frames = 0
    private var statAt = 0.0

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        surface = SurfaceView(this)
        setContentView(surface)

        engine = Engine.create()
        renderer = engine.createRenderer()
        renderer.setClearOptions(Renderer.ClearOptions().apply { clear = true; setClearColor(0.0047, 0.0052, 0.0065, 1.0) })
        aquarium = Aquarium(this, engine, TankStore(File(filesDir, "tank")))

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
        onNewIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.getBooleanExtra("feed", false)) aquarium.feed()
    }

    override fun onResume() {
        super.onResume()
        choreographer.postFrameCallback(this)
        handler.post(syncTick)
    }

    override fun onPause() {
        choreographer.removeFrameCallback(this)
        handler.removeCallbacks(syncTick)
        super.onPause()
    }

    override fun onDestroy() {
        ui.detach()
        engine.destroy()
        super.onDestroy()
    }

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
