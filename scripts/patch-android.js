/**
 * Patches android/app/src/main/AndroidManifest.xml
 * after `npx cap add android` to add all required permissions
 */
const fs   = require('fs');
const path = require('path');

const manifestPath = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'AndroidManifest.xml');

if (!fs.existsSync(manifestPath)) {
  console.log('⚠️  AndroidManifest.xml not found — run `npx cap add android` first');
  process.exit(0);
}

let content = fs.readFileSync(manifestPath, 'utf8');

const permissions = `
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.RECORD_AUDIO" />
    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />
    <uses-permission android:name="android.permission.CHANGE_WIFI_STATE" />
    <uses-permission android:name="android.permission.CHANGE_NETWORK_STATE" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />
    <uses-feature android:name="android.hardware.microphone" android:required="true" />
`;

if (!content.includes('RECORD_AUDIO')) {
  content = content.replace('<application', permissions + '\n    <application');
  fs.writeFileSync(manifestPath, content, 'utf8');
  console.log('✅ AndroidManifest.xml patched with permissions');
} else {
  console.log('ℹ️  AndroidManifest.xml already patched');
}

// Also enable cleartext traffic for LAN HTTP
if (!content.includes('usesCleartextTraffic')) {
  content = fs.readFileSync(manifestPath, 'utf8');
  content = content.replace(
    'android:label=',
    'android:usesCleartextTraffic="true"\n        android:label='
  );
  fs.writeFileSync(manifestPath, content, 'utf8');
  console.log('✅ Cleartext traffic enabled for LAN HTTP');
}
