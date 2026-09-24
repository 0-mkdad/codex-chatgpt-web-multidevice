param(
  [Parameter(Mandatory = $true)][string]$CandidateInstaller
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if ($env:CI -ne "true" -or -not $env:RUNNER_TEMP -or -not [Environment]::Is64BitOperatingSystem) {
  throw "The installer upgrade smoke requires a disposable 64-bit Windows CI runner"
}

$CandidateInstaller = (Resolve-Path -LiteralPath $CandidateInstaller).Path
$ExpectedVersion = (Get-Content -Raw (Join-Path $PSScriptRoot "..\package.json") | ConvertFrom-Json).version
if ($ExpectedVersion -ne "6.1.0") { throw "Upgrade smoke expected candidate version 6.1.0" }
$ExpectedName = "codex-web-gpt-multidevice-$ExpectedVersion-win-x64.exe"
if ([IO.Path]::GetFileName($CandidateInstaller) -ne $ExpectedName) {
  throw "Candidate installer filename does not match $ExpectedName"
}

$RegistryKey = "HKCU:\Software\7f4d5fd5-8b96-4d1d-ae3a-8c3f3c88a2b1"
if (Test-Path -LiteralPath $RegistryKey) {
  throw "Disposable CI runner already has this product registered"
}

$Scratch = Join-Path $env:RUNNER_TEMP "codex-web-gpt-upgrade-smoke"
New-Item -ItemType Directory -Path $Scratch -Force | Out-Null
$StableInstaller = Join-Path $Scratch "codex-web-gpt-multidevice-6.0.0-win-x64.exe"
$StableUrl = "https://github.com/0-mkdad/codex-chatgpt-web-multidevice/releases/download/v6.0.0/codex-web-gpt-multidevice-6.0.0-win-x64.exe"
Invoke-WebRequest -Uri $StableUrl -OutFile $StableInstaller -TimeoutSec 900
$StableDigest = "d2545b07bd15326ba06dce13be77f7b02518c04888446cfceda678eade0339b4"
if ((Get-FileHash -LiteralPath $StableInstaller -Algorithm SHA256).Hash.ToLowerInvariant() -ne $StableDigest) {
  throw "Stable v6.0.0 installer checksum mismatch"
}

$env:CODEX_WEB_GPT_LAUNCHER_DATA_DIR = Join-Path $Scratch "launcher-data"
$env:CODEX_CHATGPT_WEB_HOME = Join-Path $Scratch "core-home"
$env:CODEX_HOME = Join-Path $Scratch "codex-home"

function Invoke-Installer([string]$FilePath) {
  $Process = Start-Process -FilePath $FilePath -ArgumentList "/S", "/currentuser" -Wait -PassThru -WindowStyle Hidden
  if ($Process.ExitCode -ne 0) { throw "Installer exited with code $($Process.ExitCode)" }
}

function Get-InstalledExecutable {
  $Location = [string](Get-ItemPropertyValue -LiteralPath $RegistryKey -Name "InstallLocation")
  if (-not [IO.Path]::IsPathFullyQualified($Location)) { throw "Invalid installer location" }
  $Executable = Join-Path $Location "Codex Web GPT MultiDevice.exe"
  if (-not (Test-Path -LiteralPath $Executable)) { throw "Installed executable is missing" }
  return $Executable
}

function Invoke-Smoke([string]$Expected) {
  $env:CODEX_WEB_GPT_SMOKE_FILE = Join-Path $Scratch "ready-$Expected.json"
  Remove-Item -LiteralPath $env:CODEX_WEB_GPT_SMOKE_FILE -Force -ErrorAction SilentlyContinue
  $Executable = Get-InstalledExecutable
  $Process = Start-Process -FilePath $Executable -ArgumentList "--launcher-smoke-test" -Wait -PassThru -WindowStyle Hidden
  if ($Process.ExitCode -ne 0) { throw "Launcher smoke exited with code $($Process.ExitCode)" }
  $Marker = Get-Content -Raw -LiteralPath $env:CODEX_WEB_GPT_SMOKE_FILE | ConvertFrom-Json
  if ($Marker.ok -ne $true -or $Marker.packaged -ne $true -or $Marker.runtimeVerified -ne $true -or $Marker.version -ne $Expected) {
    throw "Launcher smoke marker did not validate version $Expected"
  }
  $Runtime = Join-Path $env:CODEX_CHATGPT_WEB_HOME "versions\$Expected-win32-x64"
  if (-not (Test-Path -LiteralPath (Join-Path $Runtime "manifest.json"))) { throw "Durable runtime $Expected is missing" }
  Write-Host "UPGRADE_SMOKE_LAUNCH_OK $Expected"
}

function Invoke-Uninstall {
  $Executable = Get-InstalledExecutable
  $Location = Split-Path -Parent $Executable
  $Uninstaller = Join-Path $Location "Uninstall Codex Web GPT MultiDevice.exe"
  if (-not (Test-Path -LiteralPath $Uninstaller)) { throw "Uninstaller is missing" }
  $Process = Start-Process -FilePath $Uninstaller -ArgumentList "/S", "/currentuser" -Wait -PassThru -WindowStyle Hidden
  if ($Process.ExitCode -ne 0) { throw "Uninstaller exited with code $($Process.ExitCode)" }
  for ($Attempt = 0; $Attempt -lt 20 -and ((Test-Path -LiteralPath $RegistryKey) -or (Test-Path -LiteralPath $Executable)); $Attempt++) {
    Start-Sleep -Milliseconds 500
  }
  if ((Test-Path -LiteralPath $RegistryKey) -or (Test-Path -LiteralPath $Executable)) {
    throw "Uninstall left its product registry key or executable behind"
  }
  Write-Host "UPGRADE_SMOKE_UNINSTALL_OK"
}

Invoke-Installer $StableInstaller
Invoke-Smoke "6.0.0"
$StatePath = Join-Path $env:CODEX_WEB_GPT_LAUNCHER_DATA_DIR "launcher-state.json"
New-Item -ItemType Directory -Path $env:CODEX_WEB_GPT_LAUNCHER_DATA_DIR -Force | Out-Null
$State = if (Test-Path -LiteralPath $StatePath) { Get-Content -Raw -LiteralPath $StatePath | ConvertFrom-Json } else { [pscustomobject]@{ version = 1 } }
$State | Add-Member -NotePropertyName language -NotePropertyValue "de" -Force
$State | Add-Member -NotePropertyName experimentalBiggerContext -NotePropertyValue $true -Force
$State | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $StatePath -Encoding UTF8

Invoke-Installer $CandidateInstaller
Invoke-Smoke $ExpectedVersion
$Migrated = Get-Content -Raw -LiteralPath $StatePath | ConvertFrom-Json
if ($Migrated.language -ne "de" -or $Migrated.experimentalBiggerContext -ne $true) {
  throw "Launcher settings were not preserved across the installer upgrade"
}
Write-Host "UPGRADE_SMOKE_STATE_OK"

Invoke-Uninstall
Invoke-Installer $CandidateInstaller
Invoke-Smoke $ExpectedVersion
Invoke-Uninstall
Write-Host "WINDOWS_UPGRADE_SMOKE_OK v6.0.0-to-v$ExpectedVersion"
