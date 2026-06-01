import 'package:flutter/material.dart';

class AppTheme {
  static const Color brandIndigo  = Color(0xFF6366f1);
  static const Color brandViolet  = Color(0xFF8b5cf6);
  static const Color brandEmerald = Color(0xFF34d399);
  static const Color brandRose    = Color(0xFFfb7185);
  static const Color bgDark       = Color(0xFF0f0f14);
  static const Color surfaceDark  = Color(0xFF1a1b2e);

  static ThemeData get dark => ThemeData(
    useMaterial3: true,
    brightness: Brightness.dark,
    colorScheme: const ColorScheme.dark(
      primary:    brandIndigo,
      secondary:  brandViolet,
      surface:    surfaceDark,
      background: bgDark,
    ),
    scaffoldBackgroundColor: bgDark,
  );

  static ThemeData get light => ThemeData(
    useMaterial3: true,
    brightness: Brightness.light,
    colorScheme: const ColorScheme.light(
      primary:   brandIndigo,
      secondary: brandViolet,
    ),
    scaffoldBackgroundColor: Colors.white,
  );
}
