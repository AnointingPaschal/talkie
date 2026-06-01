# S-talk Android Studio Project

Native Android app — no Capacitor, no Cordova.
Uses `nodejs-mobile-android` to run a real Node.js server inside the APK.

---

## One-time setup

### 1. Prerequisites
- **Android Studio Hedgehog** or newer — https://developer.android.com/studio
- **Node.js 18+** — https://nodejs.org (only needed for the bundle step)
- **Android phone** with Android 8.0+ (API 26+)

### 2. Bundle the Node.js server dependencies

Open a terminal **inside the `android-native/` folder** and run:

```bash
./bundle-nodejs.sh
```
*(On Windows: `bash bundle-nodejs.sh` or run the npm install manually)*

This installs `express` and `socket.io` into:
```
app/src/main/assets/nodejs-project/node_modules/
```

### 3. Open in Android Studio

- Launch Android Studio
- Choose **"Open"** (NOT "New Project")
- Select the `android-native/` folder
- Wait for Gradle sync to complete (~2 minutes)

### 4. Build & run

**On a connected phone:**
- Enable USB debugging on phone (Settings → Developer options)
- Press ▶ **Run** in Android Studio

**Build APK only:**
- Menu: **Build → Build Bundle(s)/APK(s) → Build APK(s)**
- APK at: `app/build/outputs/apk/debug/app-debug.apk`

---

## How it works

```
App launches
    ↓
ServerService starts (foreground) — keeps server alive when minimized
    ↓
Node.js runtime starts (nodejs-mobile-android)
    ↓  runs nodejs-project/index.js
Socket.io server listening on localhost:3000
    ↓  sends "server-ready" message
WebView loads http://localhost:3000
    ↓
S-talk UI appears — splash fades out
    ↓
LAN IP shown on screen (e.g. http://192.168.1.5:3000)
    ↓
Other devices on same Wi-Fi open that URL in Chrome
```

---

## Offline usage

- The app works 100% offline — no internet needed
- One Android phone runs the server
- Up to ~10 other devices connect via Wi-Fi
- The server stays running even when the app is minimized (foreground service)
- A notification "S-talk is running" shows while the server is active

## Update web app files

After changing `public/` files:
1. Copy new files to `app/src/main/assets/nodejs-project/../public/` 
   *(symlink from the parent project is ideal)*
2. Rebuild in Android Studio

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Gradle sync fails | File → Invalidate Caches → Restart |
| "SDK not found" | SDK Manager → install Android API 34 |
| Server never starts | Check Logcat for "STalk" tag errors |
| Mic doesn't work | Settings → Apps → S-talk → Permissions → Microphone → Allow |
| Others can't connect | Check same Wi-Fi network; disable mobile data on both devices |
| App killed in background | Battery optimization: Settings → Battery → S-talk → Unrestricted |
