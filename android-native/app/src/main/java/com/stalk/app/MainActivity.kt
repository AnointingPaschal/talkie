package com.stalk.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import android.webkit.*
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewAssetLoader
import com.janeasystems.nodejsmobile.NodeJsMobile

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var splashView: LinearLayout
    private lateinit var splashStatus: TextView
    private var serverReady = false

    companion object {
        const val TAG = "STalk"
        const val MIC_PERMISSION_CODE = 100
        const val SERVER_PORT = 3000
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Full-screen immersive
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
        )

        // Build layout programmatically — no XML needed
        val root = FrameLayout(this)

        // WebView
        webView = WebView(this)
        root.addView(webView, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ))

        // Splash screen overlay
        splashView = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = android.view.Gravity.CENTER
            setBackgroundColor(0xFF0f0f14.toInt())
            val logo = android.widget.ImageView(this@MainActivity)
            // Load logo from assets
            try {
                val stream = assets.open("public/logo.svg")
                stream.close()
            } catch (_: Exception) {}

            val title = TextView(this@MainActivity).apply {
                text = "S-talk"
                textSize = 28f
                setTextColor(0xFFf1f5f9.toInt())
                typeface = android.graphics.Typeface.DEFAULT_BOLD
                gravity = android.view.Gravity.CENTER
            }
            splashStatus = TextView(this@MainActivity).apply {
                text = "Starting server…"
                textSize = 13f
                setTextColor(0xFF94a3b8.toInt())
                gravity = android.view.Gravity.CENTER
                setPadding(0, 16, 0, 0)
            }
            addView(title)
            addView(splashStatus)
        }
        root.addView(splashView, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ))

        setContentView(root)
        setupWebView()
        requestMicPermission()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        webView.apply {
            settings.apply {
                javaScriptEnabled            = true
                domStorageEnabled            = true
                allowFileAccess              = true
                allowContentAccess           = true
                mediaPlaybackRequiresUserGesture = false
                mixedContentMode             = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                cacheMode                    = WebSettings.LOAD_NO_CACHE
                setSupportZoom(false)
                builtInZoomControls          = false
                displayZoomControls          = false
                useWideViewPort              = true
                loadWithOverviewMode         = true
                databaseEnabled              = true
                javaScriptCanOpenWindowsAutomatically = true
            }

            // Allow microphone in WebView
            webChromeClient = object : WebChromeClient() {
                override fun onPermissionRequest(request: PermissionRequest) {
                    request.grant(request.resources)
                }
                override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
                    Log.d(TAG, "WebView: ${msg.message()}")
                    return true
                }
            }

            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView, url: String) {
                    Log.d(TAG, "Page loaded: $url")
                }
                override fun onReceivedError(view: WebView, req: WebResourceRequest, error: WebResourceError) {
                    Log.e(TAG, "WebView error: ${error.description} for ${req.url}")
                }
            }

            // Keep WebView alive while server starts
            visibility = View.INVISIBLE
        }
    }

    private fun startNodeServer() {
        updateSplash("Starting server…")
        Log.d(TAG, "Starting Node.js server")

        // Listen for messages from Node.js
        NodeJsMobile.addListener { message ->
            Log.d(TAG, "Node.js message: $message")
            if (message.contains("server-ready") && !serverReady) {
                serverReady = true
                runOnUiThread { onServerReady() }
            }
        }

        // Start Node.js — it runs nodejs-project/index.js from assets
        try {
            NodeJsMobile.startNodeWithArguments(arrayOf("node", "index.js"))
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start Node.js: ${e.message}")
            runOnUiThread {
                updateSplash("Server error: ${e.message}")
            }
        }

        // Fallback: if no ready signal after 5 seconds, try loading anyway
        webView.postDelayed({
            if (!serverReady) {
                serverReady = true
                runOnUiThread { onServerReady() }
            }
        }, 5000)
    }

    private fun onServerReady() {
        updateSplash("Connecting…")
        Log.d(TAG, "Server ready — loading WebView")

        webView.loadUrl("http://localhost:$SERVER_PORT")

        // Fade out splash after page loads
        webView.postDelayed({
            webView.visibility = View.VISIBLE
            splashView.animate()
                .alpha(0f)
                .setDuration(400)
                .withEndAction { splashView.visibility = View.GONE }
                .start()
        }, 1200)

        // Start foreground service to keep server alive when backgrounded
        val intent = Intent(this, ServerService::class.java)
        ContextCompat.startForegroundService(this, intent)
    }

    private fun updateSplash(status: String) {
        splashStatus.text = status
    }

    private fun requestMicPermission() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(
                this,
                arrayOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.MODIFY_AUDIO_SETTINGS),
                MIC_PERMISSION_CODE
            )
        } else {
            startNodeServer()
        }
    }

    override fun onRequestPermissionsResult(code: Int, perms: Array<String>, results: IntArray) {
        super.onRequestPermissionsResult(code, perms, results)
        if (code == MIC_PERMISSION_CODE) {
            // Start server regardless of mic result — user can grant later in settings
            startNodeServer()
        }
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack()
        else super.onBackPressed()
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onPause() {
        super.onPause()
        webView.onPause()
    }
}
