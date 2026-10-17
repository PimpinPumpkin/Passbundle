<#
.SYNOPSIS
  Tries PassBundle's Windows Hello unlock on this PC, with a local test server.

.DESCRIPTION
  For a PC with Windows Hello set up. Run it from the unzipped test kit, in
  PowerShell as administrator. It:
    - starts a PassBundle server for this test at http://localhost:8817,
    - installs the desktop agent for you and starts it (it lives in the tray),
    - lets the kit's extension reach the agent from Chrome and Edge,
    - points the kit's extension at the test server (a browser policy, which
      needs admin; it doesn't force-install anything or change other settings).
  Then it shows the few clicks left. Everything stays on this PC.
  Run it again with -Remove to undo all of it, test server data included.

.EXAMPLE
  .\Try-WindowsHello.ps1
.EXAMPLE
  .\Try-WindowsHello.ps1 -Remove
#>
[CmdletBinding()]
param(
  [switch] $Remove,
  # For the automated check: set up and return without the instructions.
  [switch] $Quiet
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Kit = $PSScriptRoot
$Data = Join-Path $env:LOCALAPPDATA "PassBundle\test-kit"
$Port = 8817
$ServerUrl = "http://localhost:$Port"
$HostName = "com.passbundle.agent"
$ExtensionId = (Get-Content (Join-Path $Kit "extension-key.json") -Raw | ConvertFrom-Json).id
# Chrome, Edge, and Chromium (the kit's automated check uses Chromium).
$Browsers = @(
  @{ Hosts = "HKCU:\Software\Google\Chrome\NativeMessagingHosts"; Policies = "HKLM:\SOFTWARE\Policies\Google\Chrome" },
  @{ Hosts = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts"; Policies = "HKLM:\SOFTWARE\Policies\Microsoft\Edge" },
  @{ Hosts = "HKCU:\Software\Chromium\NativeMessagingHosts"; Policies = "HKLM:\SOFTWARE\Policies\Chromium" }
)

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  throw "Run this in PowerShell as administrator: the extension's server address is a browser policy."
}

function Stop-KitProcesses {
  foreach ($name in "passbundle-agent", "passbundle-agent-host", "vaultwarden") {
    Get-Process -Name $name -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -and $_.Path.StartsWith($Data, [StringComparison]::OrdinalIgnoreCase) } |
      Stop-Process -Force
  }
}

function Remove-Kit {
  Stop-KitProcesses
  foreach ($b in $Browsers) {
    $hostKey = Join-Path $b.Hosts $HostName
    if (Test-Path $hostKey) { Remove-Item $hostKey -Recurse -Force }
    $policy = Join-Path $b.Policies "3rdparty\extensions\$ExtensionId"
    if (Test-Path $policy) { Remove-Item $policy -Recurse -Force }
  }
  if (Test-Path $Data) {
    # A process can hold a file for a moment after it's stopped.
    for ($try = 0; $try -lt 10 -and (Test-Path $Data); $try++) {
      Remove-Item $Data -Recurse -Force -ErrorAction SilentlyContinue
      if (Test-Path $Data) { Start-Sleep -Milliseconds 500 }
    }
  }
  Write-Output "Removed the PassBundle test kit."
}

if ($Remove) {
  Remove-Kit
  return
}

# Start from a clean slate if it ran before.
Stop-KitProcesses

# The agent and the native-messaging host, for the kit's extension only.
$agentDir = Join-Path $Data "agent"
New-Item -ItemType Directory -Force $agentDir | Out-Null
Copy-Item (Join-Path $Kit "agent\*") $agentDir -Force
$manifest = Join-Path $agentDir "$HostName.json"
$json = [ordered]@{
  name            = $HostName
  description     = "PassBundle desktop agent (test kit)"
  path            = Join-Path $agentDir "passbundle-agent-host.exe"
  type            = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json
[System.IO.File]::WriteAllText($manifest, $json, (New-Object System.Text.UTF8Encoding $false))

foreach ($b in $Browsers) {
  $hostKey = Join-Path $b.Hosts $HostName
  if (-not (Test-Path $hostKey)) { New-Item -Path $hostKey -Force | Out-Null }
  Set-Item -Path $hostKey -Value $manifest
  # The extension's server, as the real installer hands it over. Plain HTTP
  # works here because it's localhost; the setup dialog only takes HTTPS.
  $environment = Join-Path $b.Policies "3rdparty\extensions\$ExtensionId\policy\environment"
  if (-not (Test-Path $environment)) { New-Item -Path $environment -Force | Out-Null }
  New-ItemProperty -Path $environment -Name "base" -Value $ServerUrl -PropertyType String -Force | Out-Null
}

# The test server, with its data in the kit's folder.
$serverDir = Join-Path $Data "server"
New-Item -ItemType Directory -Force (Join-Path $serverDir "data") | Out-Null
Copy-Item (Join-Path $Kit "server\vaultwarden.exe") $serverDir -Force
$env:DATA_FOLDER = Join-Path $serverDir "data"
$env:WEB_VAULT_FOLDER = Join-Path $Kit "web-vault"
$env:WEB_VAULT_ENABLED = "true"
$env:ROCKET_ADDRESS = "127.0.0.1"
$env:ROCKET_PORT = "$Port"
$env:DOMAIN = $ServerUrl
$env:SIGNUPS_ALLOWED = "true"
$env:SIGNUPS_VERIFY = "false"
$env:DISABLE_ICON_DOWNLOAD = "true"
$env:LOG_FILE = Join-Path $serverDir "server.log"
Start-Process -FilePath (Join-Path $serverDir "vaultwarden.exe") -WorkingDirectory $serverDir -WindowStyle Hidden
$up = $false
for ($try = 0; $try -lt 60 -and -not $up; $try++) {
  Start-Sleep -Milliseconds 500
  try { $up = (Invoke-WebRequest -Uri "$ServerUrl/alive" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { }
}
if (-not $up) { throw "The test server didn't start; see $env:LOG_FILE" }

# The agent, as you: it shows in the tray.
Start-Process -FilePath (Join-Path $agentDir "passbundle-agent.exe")

if ($Quiet) { return }

Write-Output @"

PassBundle test kit is running.

  Test server: $ServerUrl
  Agent: in the tray (the PassBundle lock icon)

1. Open $ServerUrl in Chrome or Edge and create an account.
2. Open chrome://extensions (or edge://extensions), turn on Developer mode,
   choose "Load unpacked", and pick this folder:
     $(Join-Path $Kit "extension")
   Pin the PassBundle extension, open it, and log in. It already knows the server.
3. In the extension: Settings > Account security > "Unlock with biometrics".
   Windows Hello asks; confirm. (The first time, it may ask twice.)
4. Lock it: click your account at the top of the extension, then "Lock now".
   Open the extension again and choose "Unlock with biometrics". Windows Hello
   asks; confirm, and it should unlock.
5. Try canceling the Windows Hello prompt once: it should stay locked.

Tell Claude what happened at each step. When you're done:
  .\Try-WindowsHello.ps1 -Remove
"@
