import 'package:flutter/material.dart';

/// Colours taken from the FieldVisit designs.
abstract final class Palette {
  static const background = Color(0xFFF4F6F5);
  static const surface = Colors.white;
  static const ink = Color(0xFF12343B);
  static const muted = Color(0xFF5F6B6D);
  static const divider = Color(0xFFE3E7E6);
  static const navIdle = Color(0xFFB8C4C2);

  static const teal = Color(0xFF1F7A6C);
  static const tealSoft = Color(0xFFDDEEE9);

  static const amber = Color(0xFF8A5A0B);
  static const amberDot = Color(0xFFB5750F);
  static const amberSoft = Color(0xFFFCEFD9);

  static const blue = Color(0xFF1D4E79);
  static const blueDot = Color(0xFF2C7BBF);
  static const blueSoft = Color(0xFFE1EEF8);

  static const red = Color(0xFF8F2D1E);
  static const redStrong = Color(0xFFC9553E);
  static const redSoft = Color(0xFFF8E3DE);
}

ThemeData buildTheme() {
  final scheme = ColorScheme.fromSeed(
    seedColor: Palette.teal,
    primary: Palette.teal,
    surface: Palette.surface,
    error: Palette.redStrong,
  );
  const radius = BorderRadius.all(Radius.circular(18));
  return ThemeData(
    colorScheme: scheme,
    scaffoldBackgroundColor: Palette.background,
    appBarTheme: const AppBarTheme(
      backgroundColor: Palette.surface,
      foregroundColor: Palette.ink,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 0,
      titleTextStyle: TextStyle(
        color: Palette.ink,
        fontSize: 24,
        fontWeight: FontWeight.w800,
      ),
      shape: Border(bottom: BorderSide(color: Palette.divider)),
    ),
    textTheme: const TextTheme(
      headlineSmall: TextStyle(color: Palette.ink, fontWeight: FontWeight.w800),
      titleLarge: TextStyle(
        color: Palette.ink,
        fontWeight: FontWeight.w800,
        fontSize: 20,
      ),
      titleMedium: TextStyle(
        color: Palette.ink,
        fontWeight: FontWeight.w800,
        fontSize: 17,
      ),
      bodyLarge: TextStyle(color: Palette.ink, fontSize: 16),
      bodyMedium: TextStyle(color: Palette.muted, fontSize: 15),
    ),
    cardTheme: const CardThemeData(
      color: Palette.surface,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(borderRadius: radius),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: Palette.teal,
        foregroundColor: Colors.white,
        minimumSize: const Size.fromHeight(56),
        shape: const RoundedRectangleBorder(borderRadius: radius),
        textStyle: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: Palette.teal,
        minimumSize: const Size.fromHeight(52),
        side: const BorderSide(color: Palette.teal),
        shape: const RoundedRectangleBorder(borderRadius: radius),
        textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
      ),
    ),
    inputDecorationTheme: const InputDecorationTheme(
      filled: true,
      fillColor: Palette.surface,
      border: OutlineInputBorder(
        borderRadius: BorderRadius.all(Radius.circular(14)),
        borderSide: BorderSide(color: Palette.divider),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.all(Radius.circular(14)),
        borderSide: BorderSide(color: Palette.divider),
      ),
    ),
    dividerTheme: const DividerThemeData(color: Palette.divider, space: 1),
  );
}
