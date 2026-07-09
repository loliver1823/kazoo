# Builds the Spindle Android APK:
#   1. wails build (or any prior build) must have produced frontend/dist
#   2. cross-compile the Go server for arm64 (pure Go, no NDK needed)
#   3. package it as libspindle.so inside the WebView shell APK
#
# Requires: Go, JDK 17+, Android SDK (sdk.dir in android-app/local.properties
# or ANDROID_HOME), Gradle 8.5+ on PATH or at $env:GRADLE_BIN.

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

if (-not (Test-Path "frontend/dist/index.html")) {
    throw "frontend/dist missing - run 'wails build' first so the frontend is embedded"
}

Write-Host "Cross-compiling Go server for android/arm64..."
$env:GOOS = "android"; $env:GOARCH = "arm64"; $env:CGO_ENABLED = "0"
go build -o "android-app/app/src/main/jniLibs/arm64-v8a/libspindle.so" .
Remove-Item Env:GOOS, Env:GOARCH, Env:CGO_ENABLED

Write-Host "Assembling APK..."
$gradle = if ($env:GRADLE_BIN) { $env:GRADLE_BIN } else { "gradle" }
Set-Location "$root/android-app"
& $gradle :app:assembleDebug
Write-Host "APK: android-app/app/build/outputs/apk/debug/app-debug.apk"
