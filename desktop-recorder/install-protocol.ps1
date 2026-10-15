$ErrorActionPreference = 'Stop'
$project = Join-Path $PSScriptRoot 'LearnWithMe.Recorder.csproj'
if (-not (Test-Path $project)) { throw 'Could not find LearnWithMe.Recorder.csproj beside this installer.' }

# Register the compiled WinExe directly. Registering PowerShell as the protocol
# handler causes Chrome to show "Open Windows PowerShell?" during outline
# commands, including while recording. Build once at install time instead.
$publishDir = Join-Path $PSScriptRoot 'publish'
dotnet publish $project -c Release -o $publishDir
if ($LASTEXITCODE -ne 0) { throw 'Could not publish the desktop recorder.' }
$recorderExe = Join-Path $publishDir 'LearnWithMe.Recorder.exe'
if (-not (Test-Path $recorderExe)) { throw 'Published recorder executable was not found.' }

$schemeKey = 'HKCU:\Software\Classes\learnwithme-recorder'
$commandKey = Join-Path $schemeKey 'shell\open\command'
New-Item -Path $commandKey -Force | Out-Null
Set-Item -Path $schemeKey -Value 'URL:Learn with me Desktop Recorder'
New-ItemProperty -Path $schemeKey -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
$command = '"' + $recorderExe + '" "%1"'
Set-Item -Path $commandKey -Value $command
Write-Host 'Registered learnwithme-recorder:// to LearnWithMe.Recorder.exe.'
Write-Host 'Restart Chrome/Edge, then click Launch Desktop Recorder once.'
Write-Host 'On the first browser prompt, select Always allow for this app and confirm.'
