package wtf.kazoo

import android.annotation.SuppressLint
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * Kazoo's Android shell: exec the bundled Go server (libkazoo.so, a real
 * arm64 executable shipped through jniLibs) and host the frontend it serves
 * in a fullscreen WebView.
 */
class MainActivity : AppCompatActivity() {

    private var server: Process? = null
    private lateinit var web: WebView

    private val addr = "127.0.0.1:8899"

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        web = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            webChromeClient = WebChromeClient()
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    // Keep the app on the local server; external links go to the browser.
                    return if (request.url.host == "127.0.0.1") false else {
                        startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, request.url))
                        true
                    }
                }
            }
        }
        setContentView(web)

        startServerAndLoad()
    }

    private fun startServerAndLoad() {
        thread {
            try {
                if (!isUp()) {
                    val bin = File(applicationInfo.nativeLibraryDir, "libkazoo.so")
                    val home = filesDir.absolutePath
                    val music = File(getExternalFilesDir(null), "Music").apply { mkdirs() }
                    val pb = ProcessBuilder(bin.absolutePath, "serve", addr)
                    pb.environment()["HOME"] = home
                    pb.environment()["KAZOO_DEFAULT_MUSIC_DIR"] = music.absolutePath
                    pb.redirectErrorStream(true)
                    server = pb.start()
                    // Drain output so the child never blocks on a full pipe.
                    thread {
                        server?.inputStream?.bufferedReader()?.useLines { lines ->
                            lines.forEach { android.util.Log.i("kazoo-server", it) }
                        }
                    }
                }
                // Wait for the server to come up (fresh library init can take a moment).
                val deadline = System.currentTimeMillis() + 30_000
                while (System.currentTimeMillis() < deadline && !isUp()) {
                    Thread.sleep(250)
                }
                runOnUiThread { web.loadUrl("http://$addr/") }
            } catch (e: Exception) {
                android.util.Log.e("kazoo", "server start failed", e)
            }
        }
    }

    private fun isUp(): Boolean = try {
        val conn = URL("http://$addr/").openConnection() as HttpURLConnection
        conn.connectTimeout = 500
        conn.readTimeout = 500
        conn.requestMethod = "HEAD"
        conn.responseCode in 200..399
    } catch (e: Exception) {
        false
    }

    override fun onDestroy() {
        super.onDestroy()
        if (isFinishing) {
            server?.destroy()
        }
    }
}
