#!/bin/bash
# Run this once before opening Android Studio
# It installs the Node.js server dependencies into the assets folder

set -e
echo "Installing Node.js server dependencies for Android..."

ASSETS_DIR="app/src/main/assets/nodejs-project"
cd "$ASSETS_DIR"

# Install with the Android-compatible Node.js binary
npm install --production --no-optional
echo ""
echo "✅ Dependencies installed in $ASSETS_DIR/node_modules"
echo "Now sync in Android Studio or run: ./gradlew assembleDebug"
