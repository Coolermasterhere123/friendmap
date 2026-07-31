# FriendMap Android Setup Script
# Run this after "cap add android" to set everything up automatically

Write-Host "Setting up Android project..." -ForegroundColor Cyan

# 1. Set SDK location
$sdkPath = "sdk.dir=C:/Users/User/AppData/Local/Android/Sdk"
Set-Content -Path "android\local.properties" -Value $sdkPath
Write-Host "✓ SDK location set" -ForegroundColor Green

# 2. Copy AndroidManifest.xml
Copy-Item -Path "android-config\AndroidManifest.xml" -Destination "android\app\src\main\AndroidManifest.xml" -Force
Write-Host "✓ AndroidManifest.xml copied with all permissions" -ForegroundColor Green

Write-Host ""
Write-Host "Done! Now open Android Studio and press the Play button." -ForegroundColor Cyan
Write-Host "Run: cap open android" -ForegroundColor Yellow
