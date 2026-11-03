package info.arenoros.aquarium

import android.app.Activity
import android.os.Bundle
import android.util.Log
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient

// Пробник: открывает аквариум по адресу из интента и пишет fps в logcat.
//   adb reverse tcp:8000 tcp:8000
//   adb shell am start -n info.arenoros.aquarium/.MainActivity -e url "http://localhost:8000/t/<код>?tv"
//   adb logcat -s aqua
class MainActivity : Activity() {
    private lateinit var web: WebView

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WebView.setWebContentsDebuggingEnabled(true)

        web = WebView(this)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                Log.i("aqua", m.message())
                return true
            }
        }
        web.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                view.evaluateJavascript(FPS_PROBE, null)
            }
        }
        setContentView(web)
        web.loadUrl(intent.getStringExtra("url") ?: "http://localhost:8000/")
    }

    override fun onResume() { super.onResume(); web.onResume() }
    override fun onPause() { web.onPause(); super.onPause() }
    override fun onDestroy() { web.destroy(); super.onDestroy() }
}

// Счёт кадров за 5 с: средний fps, худший кадр и размер буфера отрисовки.
private const val FPS_PROBE = """
(function () {
  if (window.__probe) return; window.__probe = 1;
  var d = document.createElement('div');
  d.style.cssText = 'position:fixed;left:8px;top:8px;z-index:99999;font:14px monospace;' +
    'color:#0f0;background:rgba(0,0,0,.6);padding:4px 8px;pointer-events:none';
  document.body.appendChild(d);
  var n = 0, t0 = performance.now(), last = t0, worst = 0;
  function tick(now) {
    n++; worst = Math.max(worst, now - last); last = now;
    if (now - t0 >= 5000) {
      var c = document.querySelector('canvas');
      var s = 'fps ' + (n * 1000 / (now - t0)).toFixed(1) + ' worst ' + worst.toFixed(0) + 'ms' +
        (c ? ' buf ' + c.width + 'x' + c.height : '') + ' dpr ' + devicePixelRatio;
      d.textContent = s; console.log('[probe] ' + s);
      n = 0; t0 = now; worst = 0;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();
"""
