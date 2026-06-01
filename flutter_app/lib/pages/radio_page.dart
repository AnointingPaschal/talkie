import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:network_info_plus/network_info_plus.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../services/server_service.dart';
import '../theme/app_theme.dart';

class RadioPage extends StatefulWidget {
  final void Function(bool isDark) onThemeChanged;
  const RadioPage({super.key, required this.onThemeChanged});

  @override
  State<RadioPage> createState() => _RadioPageState();
}

class _RadioPageState extends State<RadioPage> {
  InAppWebViewController? _webCtrl;
  bool  _loading   = true;
  bool  _isDark    = true;
  String _serverUrl = '';
  String _wifiName  = '';
  int    _wifiStrength = 0;

  final _server  = ServerService();
  Timer? _netTimer;

  @override
  void initState() {
    super.initState();
    _loadTheme();
    _resolveServerUrl();
    _startNetworkPolling();
  }

  Future<void> _loadTheme() async {
    final prefs = await SharedPreferences.getInstance();
    final t = prefs.getString('stalk-theme') ?? 'dark';
    setState(() => _isDark = t != 'light');
  }

  Future<void> _resolveServerUrl() async {
    final prefs = await SharedPreferences.getInstance();
    final saved = prefs.getString('wt_server');
    setState(() => _serverUrl = saved ?? _server.localUrl);
  }

  void _startNetworkPolling() {
    _fetchNetworkInfo();
    _netTimer = Timer.periodic(const Duration(seconds: 10), (_) => _fetchNetworkInfo());
  }

  Future<void> _fetchNetworkInfo() async {
    try {
      final ni   = NetworkInfo();
      final ssid = await ni.getWifiName() ?? '';
      setState(() => _wifiName = ssid.replaceAll('"', ''));
    } catch (_) {}
  }

  void _toggleTheme() async {
    final newDark = !_isDark;
    setState(() => _isDark = newDark);
    widget.onThemeChanged(newDark);
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('stalk-theme', newDark ? 'dark' : 'light');
    // Tell the WebView to switch theme too
    _webCtrl?.evaluateJavascript(source:
      "localStorage.setItem('stalk-theme','${newDark ? 'dark' : 'light'}');"
      "document.documentElement.classList.toggle('dark', ${newDark});"
    );
  }

  void _showServerDialog() async {
    final prefs  = await SharedPreferences.getInstance();
    final ctrl   = TextEditingController(text: prefs.getString('wt_server') ?? '');
    if (!mounted) return;
    showDialog(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: _isDark ? AppTheme.surfaceDark : Colors.white,
        title: Text('Server URL',
          style: TextStyle(color: _isDark ? Colors.white : Colors.black)),
        content: TextField(
          controller: ctrl,
          style: TextStyle(color: _isDark ? Colors.white : Colors.black),
          decoration: InputDecoration(
            hintText: 'https://your-app.onrender.com',
            hintStyle: TextStyle(color: Colors.grey.shade500),
            enabledBorder: OutlineInputBorder(
              borderSide: BorderSide(color: Colors.grey.shade700)),
            focusedBorder: const OutlineInputBorder(
              borderSide: BorderSide(color: AppTheme.brandIndigo)),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () async {
              await prefs.remove('wt_server');
              setState(() => _serverUrl = _server.localUrl);
              Navigator.pop(context);
              _webCtrl?.loadUrl(urlRequest: URLRequest(
                url: WebUri(_server.localUrl)));
            },
            child: const Text('Reset to LAN',
              style: TextStyle(color: AppTheme.brandRose)),
          ),
          TextButton(
            onPressed: () async {
              final url = ctrl.text.trim();
              if (url.isNotEmpty) {
                await prefs.setString('wt_server', url);
                setState(() => _serverUrl = url);
                Navigator.pop(context);
                _webCtrl?.loadUrl(urlRequest: URLRequest(url: WebUri(url)));
              } else {
                Navigator.pop(context);
              }
            },
            child: const Text('Save',
              style: TextStyle(color: AppTheme.brandIndigo)),
          ),
        ],
      ),
    );
  }

  @override
  void dispose() {
    _netTimer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final bg = _isDark ? AppTheme.bgDark : Colors.white;
    final statusBg = _isDark
        ? const Color(0xFF13152a).withOpacity(.9)
        : Colors.white.withOpacity(.95);

    return Scaffold(
      backgroundColor: bg,
      body: SafeArea(
        child: Stack(
          children: [
            // ── WebView ──────────────────────────────────────────
            if (_serverUrl.isNotEmpty)
              InAppWebView(
                initialUrlRequest: URLRequest(url: WebUri(_serverUrl)),
                initialSettings: InAppWebViewSettings(
                  javaScriptEnabled:               true,
                  domStorageEnabled:               true,
                  mediaPlaybackRequiresUserGesture: false,
                  allowsInlineMediaPlayback:        true,
                  mixedContentMode:                 MixedContentMode.MIXED_CONTENT_ALWAYS_ALLOW,
                  useWideViewPort:                 true,
                  loadWithOverviewMode:            true,
                  cacheMode:                       CacheMode.LOAD_NO_CACHE,
                  useShouldOverrideUrlLoading:     true,
                  disableContextMenu:              false,
                  verticalScrollBarEnabled:        false,
                  horizontalScrollBarEnabled:      false,
                  allowFileAccess:                 true,
                  allowContentAccess:              true,
                ),
                onWebViewCreated: (ctrl) {
                  _webCtrl = ctrl;
                  // Inject Flutter bridge for theme sync
                  ctrl.addJavaScriptHandler(
                    handlerName: 'flutterBridge',
                    callback: (args) {
                      final action = args.isNotEmpty ? args[0] as String : '';
                      if (action == 'toggleTheme') _toggleTheme();
                      return null;
                    },
                  );
                },
                onPermissionRequest: (ctrl, req) async {
                  return PermissionResponse(
                    resources: req.resources,
                    action: PermissionResponseAction.GRANT,
                  );
                },
                onLoadStop: (ctrl, url) {
                  setState(() => _loading = false);
                  // Apply saved theme
                  ctrl.evaluateJavascript(source:
                    "document.documentElement.classList.toggle('dark', ${_isDark});"
                    "localStorage.setItem('stalk-theme', '${_isDark ? 'dark' : 'light'}');");
                },
                onLoadError: (ctrl, url, code, msg) {
                  debugPrint('WebView error $code: $msg');
                },
              ),

            // ── Loading overlay ───────────────────────────────────
            if (_loading)
              Container(
                color: bg,
                child: Center(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Container(
                        width: 72, height: 72,
                        decoration: BoxDecoration(
                          gradient: const LinearGradient(
                            colors: [AppTheme.brandIndigo, AppTheme.brandViolet],
                          ),
                          borderRadius: BorderRadius.circular(18),
                          boxShadow: [BoxShadow(
                            color: AppTheme.brandIndigo.withOpacity(.4),
                            blurRadius: 24,
                          )],
                        ),
                        child: const Icon(Icons.radio,
                          color: Colors.white, size: 36),
                      ),
                      const SizedBox(height: 20),
                      const SizedBox(
                        width: 20, height: 20,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: AppTheme.brandIndigo,
                        ),
                      ),
                    ],
                  ),
                ),
              ),

            // ── Floating top bar (outside WebView) ────────────────
            Positioned(
              top: 0, left: 0, right: 0,
              child: Container(
                height: 44,
                color: statusBg,
                padding: const EdgeInsets.symmetric(horizontal: 12),
                child: Row(
                  children: [
                    // Wi-Fi info
                    if (_wifiName.isNotEmpty) ...[
                      const Icon(Icons.wifi, size: 14,
                        color: AppTheme.brandEmerald),
                      const SizedBox(width: 4),
                      Text(_wifiName,
                        style: const TextStyle(
                          fontSize: 11, fontWeight: FontWeight.w600,
                          color: AppTheme.brandEmerald,
                        ),
                      ),
                      const SizedBox(width: 8),
                    ],
                    // LAN URL chip
                    if (_server.lanUrl != null)
                      GestureDetector(
                        onLongPress: () => _copyToClipboard(_server.lanUrl!),
                        child: Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 8, vertical: 3),
                          decoration: BoxDecoration(
                            color: AppTheme.brandIndigo.withOpacity(.15),
                            borderRadius: BorderRadius.circular(20),
                            border: Border.all(
                              color: AppTheme.brandIndigo.withOpacity(.35)),
                          ),
                          child: Text(
                            _server.lanUrl!,
                            style: const TextStyle(
                              fontSize: 10,
                              color: AppTheme.brandIndigo,
                              fontFamily: 'monospace',
                            ),
                          ),
                        ),
                      ),
                    const Spacer(),
                    // Theme toggle
                    IconButton(
                      onPressed: _toggleTheme,
                      icon: Icon(
                        _isDark ? Icons.light_mode : Icons.dark_mode,
                        size: 18,
                        color: _isDark
                            ? Colors.amber.shade400
                            : Colors.indigo.shade400,
                      ),
                      padding: EdgeInsets.zero,
                      constraints: const BoxConstraints(
                        minWidth: 32, minHeight: 32),
                      tooltip: 'Toggle theme',
                    ),
                    // Server settings
                    IconButton(
                      onPressed: _showServerDialog,
                      icon: Icon(Icons.settings_outlined,
                        size: 18,
                        color: (_isDark ? Colors.white : Colors.black)
                            .withOpacity(.4)),
                      padding: EdgeInsets.zero,
                      constraints: const BoxConstraints(
                        minWidth: 32, minHeight: 32),
                      tooltip: 'Server settings',
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  void _copyToClipboard(String text) async {
    await Future.value();
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text('Copied: $text'),
        duration: const Duration(seconds: 2),
        backgroundColor: AppTheme.brandIndigo,
      ),
    );
  }

  void debugPrint(String msg) => print(msg);
}
