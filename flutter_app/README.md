# S-talk Flutter App

Standard Flutter project — works on Android and iOS.

## Setup

### 1. Install Flutter
https://docs.flutter.dev/get-started/install

### 2. Install dependencies
```bash
flutter pub get
```

### 3. Install Node.js server dependencies
```bash
cd assets/nodejs
npm install --production
cd ../..
```

### 4. Run on device
```bash
flutter run
```

### 5. Build release APK
```bash
flutter build apk --release
```
APK: `build/app/outputs/flutter-apk/app-release.apk`

### Build AAB (for Play Store)
```bash
flutter build appbundle --release
```

## How offline works

- App starts → `SplashPage` asks for mic permission
- `ServerService` starts the embedded Node.js server via `flutter_nodejs_mobile`
- Node.js runs `assets/nodejs/index.js` — full Socket.io signaling server
- WebView loads the bundled app from `localhost:3000`
- LAN IP shows in the top bar — others on same Wi-Fi open that URL in Chrome

## Updating web app files

After changing files in `../../public/`:
```bash
cp ../../public/index.html assets/public/
cp ../../public/style.css  assets/public/
cp ../../public/app.js     assets/public/
flutter run
```
