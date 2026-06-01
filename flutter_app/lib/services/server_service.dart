import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/services.dart';
import 'package:flutter_nodejs_mobile/flutter_nodejs_mobile.dart';

/// Manages the embedded Node.js signaling server.
/// On Android/iOS the server runs via nodejs-mobile.
/// Falls back to a remote Render URL if no local server.
class ServerService {
  static final ServerService _instance = ServerService._internal();
  factory ServerService() => _instance;
  ServerService._internal();

  static const int port = 3000;
  bool _started = false;
  bool _ready   = false;
  String? _lanIp;

  final _readyCompleter = Completer<void>();
  StreamSubscription? _msgSub;

  bool get isReady => _ready;
  String get localUrl => 'http://localhost:$port';
  String? get lanUrl  => _lanIp != null ? 'http://$_lanIp:$port' : null;

  Future<void> start() async {
    if (_started) return;
    _started = true;

    // Listen for messages from Node.js
    _msgSub = FlutterNodejsMobile.nodeAppDataChannel.receiveBroadcastStream().listen(
      _onNodeMessage,
      onError: (e) => debugPrint('[Server] Node.js message error: $e'),
    );

    try {
      // Start the Node.js server from assets/nodejs/index.js
      await FlutterNodejsMobile.startNodeProject(
        nodeFileName: 'index.js',
      );
    } catch (e) {
      debugPrint('[Server] Failed to start Node.js: $e');
      // Mark ready anyway so the UI doesn't hang
      _markReady();
    }

    // Safety timeout — load the WebView even if no ready signal
    Future.delayed(const Duration(seconds: 6), _markReady);
  }

  void _onNodeMessage(dynamic raw) {
    try {
      final msg = raw is String ? jsonDecode(raw) : raw;
      if (msg['event'] == 'server-ready') {
        final ips = List<String>.from(msg['lanIPs'] ?? []);
        _lanIp = ips.isNotEmpty ? ips.first : null;
        debugPrint('[Server] Ready. LAN: $_lanIp');
        _markReady();
      }
    } catch (e) {
      debugPrint('[Server] Parse error: $e');
    }
  }

  void _markReady() {
    if (_ready) return;
    _ready = true;
    if (!_readyCompleter.isCompleted) _readyCompleter.complete();
  }

  Future<void> waitReady() => _readyCompleter.future;

  void dispose() {
    _msgSub?.cancel();
  }
}

void debugPrint(String msg) {
  // ignore: avoid_print
  print(msg);
}
