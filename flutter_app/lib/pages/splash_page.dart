import 'dart:async';
import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';
import '../services/server_service.dart';
import '../theme/app_theme.dart';
import 'radio_page.dart';

class SplashPage extends StatefulWidget {
  final void Function(bool isDark) onThemeChanged;
  const SplashPage({super.key, required this.onThemeChanged});

  @override
  State<SplashPage> createState() => _SplashPageState();
}

class _SplashPageState extends State<SplashPage>
    with SingleTickerProviderStateMixin {
  String _status = 'Initializing…';
  late AnimationController _fadeCtrl;
  late Animation<double>    _fadeAnim;

  @override
  void initState() {
    super.initState();
    _fadeCtrl = AnimationController(
      vsync: this, duration: const Duration(milliseconds: 800));
    _fadeAnim = CurvedAnimation(parent: _fadeCtrl, curve: Curves.easeIn);
    _fadeCtrl.forward();
    _bootstrap();
  }

  Future<void> _bootstrap() async {
    // 1. Request microphone permission
    setState(() => _status = 'Requesting microphone…');
    await Permission.microphone.request();
    await Permission.audio.request();

    // 2. Start embedded Node.js server
    setState(() => _status = 'Starting server…');
    await ServerService().start();

    // 3. Wait for server to be ready
    setState(() => _status = 'Connecting…');
    await ServerService().waitReady();

    // 4. Fade out and navigate
    setState(() => _status = 'Ready!');
    await Future.delayed(const Duration(milliseconds: 400));

    if (!mounted) return;
    Navigator.of(context).pushReplacement(
      PageRouteBuilder(
        pageBuilder: (_, a, __) =>
            RadioPage(onThemeChanged: widget.onThemeChanged),
        transitionsBuilder: (_, a, __, child) =>
            FadeTransition(opacity: a, child: child),
        transitionDuration: const Duration(milliseconds: 500),
      ),
    );
  }

  @override
  void dispose() {
    _fadeCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Scaffold(
      backgroundColor:
          isDark ? AppTheme.bgDark : Colors.white,
      body: FadeTransition(
        opacity: _fadeAnim,
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              // Logo
              Container(
                width: 96, height: 96,
                decoration: BoxDecoration(
                  gradient: const LinearGradient(
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                    colors: [AppTheme.brandIndigo, AppTheme.brandViolet],
                  ),
                  borderRadius: BorderRadius.circular(24),
                  boxShadow: [
                    BoxShadow(
                      color: AppTheme.brandIndigo.withOpacity(.4),
                      blurRadius: 30, spreadRadius: 2,
                    )
                  ],
                ),
                child: const Icon(Icons.radio, color: Colors.white, size: 48),
              ),
              const SizedBox(height: 24),
              // App name
              ShaderMask(
                shaderCallback: (b) => const LinearGradient(
                  colors: [AppTheme.brandIndigo, AppTheme.brandViolet],
                ).createShader(b),
                child: const Text(
                  'S-talk',
                  style: TextStyle(
                    fontSize: 36, fontWeight: FontWeight.w800,
                    color: Colors.white, letterSpacing: -1,
                  ),
                ),
              ),
              const SizedBox(height: 8),
              Text(
                'Voice radio over LAN or internet',
                style: TextStyle(
                  fontSize: 13,
                  color: (isDark ? Colors.white : Colors.black).withOpacity(.45),
                ),
              ),
              const SizedBox(height: 48),
              // Loading indicator
              SizedBox(
                width: 24, height: 24,
                child: CircularProgressIndicator(
                  strokeWidth: 2.5,
                  color: AppTheme.brandIndigo.withOpacity(.7),
                ),
              ),
              const SizedBox(height: 16),
              Text(
                _status,
                style: TextStyle(
                  fontSize: 13,
                  color: (isDark ? Colors.white : Colors.black).withOpacity(.4),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
