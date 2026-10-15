$ErrorActionPreference = 'Stop'
$schemeKey = 'HKCU:\Software\Classes\learnwithme-recorder'
if (Test-Path $schemeKey) { Remove-Item -Path $schemeKey -Recurse -Force; Write-Host 'Removed learnwithme-recorder:// protocol registration.' } else { Write-Host 'Protocol was not registered for this Windows user.' }
