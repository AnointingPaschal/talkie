# S-talk — Android App Build Guide

## What this builds
A fully offline Android APK. The app starts its own Node.js server on launch.
Other devices on the same Wi-Fi connect to it directly — no internet needed.

---

## Prerequisites

Install these on your PC before starting:

1. **Node.js 18+** — https://nodejs.org
2. **Android Studio** — https://developer.android.com/studio
   - During install, also install: Android SDK, Android SDK Platform-Tools
3. **Java 17** (comes with Android Studio — use the bundled JDK)

---

## Step-by-step build

### 1. Install dependencies
```bash
cd C:\path\to\talkie
npm install
cd nodejs && npm install && cd ..
```

### 2. Generate the Android project
```bash
npx cap add android
```
This creates an `android/` folder.

### 3. Apply Android permissions
```bash
node scripts/patch-android.js
```
This adds microphone, network, and wake-lock permissions to AndroidManifest.xml.

### 4. Sync Capacitor
```bash
npx cap sync android
```
This copies the `public/` folder and `nodejs/` folder into the Android project.

### 5. Open in Android Studio
```bash
npx cap open android
```
Android Studio will open automatically.

### 6. Build the APK

**Option A — Debug APK (for testing, install directly):**
In Android Studio menu: **Build → Build Bundle(s)/APK(s) → Build APK(s)**

Wait ~2 minutes. Click the **"locate"** link in the popup.

APK location:
```
android/app/build/outputs/apk/debug/app-debug.apk
```

**Option B — Release APK (for distribution):**
In Android Studio menu: **Build → Generate Signed Bundle/APK**
Follow the keystore wizard.

---

## Install APK on your phone

**Method 1 — USB:**
```bash
adb install android/app/build/outputs/apk/debug/app-debug.apk
```

**Method 2 — File transfer:**
1. Copy the APK to your phone
2. Open it in Files app
3. Enable "Install from unknown sources" when prompted

---

## How offline mode works

When someone opens S-talk on Android:

```
1. App launches → splash screen shows
2. NodeJS plugin starts the embedded server (port 3000)
3. Server sends "ready" signal to the WebView
4. Splash fades → setup screen appears
5. App connects to localhost:3000 automatically
6. LAN URL shown on screen (e.g. http://192.168.1.5:3000)
7. Other phones on same Wi-Fi open that URL in any browser
```

The phone with the app installed IS the server.
No internet, no Render, no external service needed.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `npx cap add android` fails | Make sure Android Studio + SDK is installed and `ANDROID_HOME` env var is set |
| Build fails with SDK error | Open Android Studio → SDK Manager → install API 34 |
| APK installs but mic doesn't work | Go to Settings → Apps → S-talk → Permissions → allow Microphone |
| Other phones can't connect | Make sure they're on the same Wi-Fi. Try disabling mobile data on both |
| Server shows "starting..." forever | Restart the app — Node.js takes 2-3 seconds on first launch |

---

## Update the app

After any code change:
```bash
npx cap sync android
npx cap open android
# Then rebuild APK in Android Studio
```
