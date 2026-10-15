$ErrorActionPreference = 'Stop'
$project = Join-Path $PSScriptRoot 'LearnWithMe.Recorder.csproj'
if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show('.NET 8 SDK was not found. Install it from https://dotnet.microsoft.com/en-us/download/dotnet/8.0 and try again.', 'Learn with me Recorder') | Out-Null
  exit 1
}
if (-not (Test-Path $project)) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show(('Could not find recorder project: ' + $project), 'Learn with me Recorder') | Out-Null
  exit 1
}
$root = Split-Path $PSScriptRoot -Parent
Start-Process -FilePath 'dotnet' -ArgumentList @('run', '--project', ('"' + $project + '"')) -WorkingDirectory $root -WindowStyle Hidden
