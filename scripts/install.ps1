# Qyra installer and updater for Windows.
#
#   irm https://raw.githubusercontent.com/zParik/Qyra/main/scripts/install.ps1 | iex
#
# Installs the latest Qyra, and the same command updates it:
#   - an existing .msi install (per machine) is updated with the latest .msi;
#   - otherwise the latest setup .exe installs or updates Qyra for your user,
#     with no admin prompt.
# Every download's sha256 is checked against the release before it runs.
#
# Options, passed through a script block:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/zParik/Qyra/main/scripts/install.ps1))) -Force
#   -Force   reinstall even when the latest version is already installed
#   -Msi     use the .msi (per machine, asks for admin) for a new install

param(
  [switch]$Force,
  [switch]$Msi
)

$Repo = 'zParik/Qyra'

function Say([string]$m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn([string]$m) { Write-Host "warning: $m" -ForegroundColor Yellow }

# Qyra's entry in Add/Remove Programs: the setup .exe registers per user,
# the .msi per machine.
function Get-QyraInstall {
  $keys = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  $entry = Get-ItemProperty -Path $keys -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -eq 'Qyra' } |
    Select-Object -First 1
  if (-not $entry) { return $null }
  [pscustomobject]@{
    Version = [string]$entry.DisplayVersion
    Kind    = if ($entry.WindowsInstaller -eq 1) { 'msi' } else { 'exe' }
  }
}

function ConvertTo-Version([string]$v) {
  $parsed = $null
  if ([version]::TryParse(($v -replace '^v', '' -replace '[-+].*$', ''), [ref]$parsed)) { return $parsed }
  return [version]'0.0'
}

function Install-Qyra {
  $ErrorActionPreference = 'Stop'
  if ($env:OS -ne 'Windows_NT') { throw 'this installer is for Windows. On Linux, use scripts/install.sh.' }
  if (-not [Environment]::Is64BitOperatingSystem) { throw 'Qyra needs 64-bit Windows.' }

  # Windows PowerShell 5.1 may still default to TLS 1.0, which GitHub refuses.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  # The progress bar slows Invoke-WebRequest down many times over on 5.1.
  $ProgressPreference = 'SilentlyContinue'

  Say 'Looking up the latest Qyra release'
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ 'User-Agent' = 'qyra-installer' }
  $version = $release.tag_name -replace '^v', ''
  if (-not $version) { throw 'could not read the latest version from GitHub.' }

  $current = Get-QyraInstall
  if ($current) {
    Say "Found Qyra $($current.Version) ($($current.Kind) install)"
    if ((ConvertTo-Version $current.Version) -ge (ConvertTo-Version $version) -and -not $Force) {
      Say "Qyra $($current.Version) is already installed and up to date."
      return
    }
  }

  $kind = if ($current) { $current.Kind } elseif ($Msi) { 'msi' } else { 'exe' }
  $pattern = if ($kind -eq 'msi') { '_x64_en-US\.msi$' } else { '_x64-setup\.exe$' }
  $asset = $release.assets | Where-Object { $_.name -match $pattern } | Select-Object -First 1
  if (-not $asset) { throw "the v$version release has no file matching $pattern." }

  if (Get-Process -Name 'qyra' -ErrorAction SilentlyContinue) {
    throw 'Qyra is running. Close it, then run this command again.'
  }

  $file = Join-Path $env:TEMP $asset.name
  Say "Downloading $($asset.name)"
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $file -UseBasicParsing

  try {
    if ($asset.digest -and $asset.digest -like 'sha256:*') {
      $want = $asset.digest.Substring(7)
      $got = (Get-FileHash -Path $file -Algorithm SHA256).Hash
      if ($got -ne $want) { throw "the download's checksum does not match the release; nothing was installed." }
    } else {
      Warn "The release lists no checksum for $($asset.name); skipping verification."
    }

    if ($kind -eq 'msi') {
      Say "Installing Qyra $version (Windows asks for admin rights)"
      $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', "`"$file`"", '/passive', '/norestart') -Wait -PassThru
      if ($p.ExitCode -notin 0, 3010) { throw "the installer stopped with code $($p.ExitCode)." }
    } else {
      Say "Installing Qyra $version"
      $p = Start-Process -FilePath $file -ArgumentList '/S' -Wait -PassThru
      if ($p.ExitCode -ne 0) { throw "the installer stopped with code $($p.ExitCode)." }
    }
  } finally {
    Remove-Item -Path $file -Force -ErrorAction SilentlyContinue
  }

  $after = Get-QyraInstall
  if (-not $after -or (ConvertTo-Version $after.Version) -lt (ConvertTo-Version $version)) {
    throw 'the installer finished, but Qyra does not show up as installed.'
  }
  Say "Qyra $($after.Version) is installed. Find it in the Start menu."
}

# Errors are reported, never `exit`: piped into iex, this runs inside the
# user's own PowerShell window, and exit would close it.
try {
  Install-Qyra
} catch {
  Write-Host "error: $($_.Exception.Message)" -ForegroundColor Red
}
