<#
.SYNOPSIS
  Tries PassBundle's Windows Hello unlock on this PC, with a local test server.

.DESCRIPTION
  For a PC with Windows Hello set up. Run it from the unzipped test kit, in
  PowerShell as administrator. It:
    - starts a PassBundle server for this test at https://localhost:8817,
      with a certificate made on this PC for it (trusted until -Remove),
    - installs the desktop agent for you and starts it (it lives in the tray),
    - lets the kit's extension reach the agent from Chrome and Edge,
    - points the kit's extension at the test server (a browser policy, which
      needs admin; it doesn't force-install anything or change other settings).
  Then it shows the few clicks left. Everything stays on this PC.
  Run it again with -Remove to undo all of it, test server data and the
  certificate included.

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
# Windows PowerShell 5.1 offers only old TLS versions unless asked, and looks
# for a proxy before every connection, even to this PC. The kit only talks to
# localhost, so it goes direct.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
[Net.WebRequest]::DefaultWebProxy = $null

$Kit = $PSScriptRoot
$Data = Join-Path $env:LOCALAPPDATA "PassBundle\test-kit"
$Port = 8817
$ServerUrl = "https://localhost:$Port"
# The extension only talks to HTTPS servers. The kit's certificate authority
# is trusted only while the kit is installed, and its key is thrown away the
# moment it has signed the server's certificate (New-KitCertificate).
$CertSubject = "CN=PassBundle test kit (localhost only)"
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

function Remove-KitCertificate {
  $store = [System.Security.Cryptography.X509Certificates.X509Store]::new("Root", "LocalMachine")
  $store.Open("ReadWrite")
  try {
    foreach ($cert in @($store.Certificates | Where-Object { $_.Subject -eq $CertSubject })) { $store.Remove($cert) }
  } finally {
    $store.Close()
  }
}

# DER, the encoding the server's key file uses. Windows PowerShell 5.1 can't
# write a key as PEM on its own, so the few bytes are spelled out here.
function ConvertTo-Der([byte] $Tag, [byte[]] $Content) {
  $n = $Content.Length
  if ($n -lt 0x80) { $head = @($Tag, $n) }
  elseif ($n -lt 0x100) { $head = @($Tag, 0x81, $n) }
  else { $head = @($Tag, 0x82, ($n -shr 8), ($n -band 0xff)) }
  return [byte[]] (@($head) + @($Content))
}

function ConvertTo-DerInteger([byte[]] $BigEndian) {
  # Unsigned: drop leading zeros, then add one back if the top bit is set.
  $i = 0
  while ($i -lt $BigEndian.Length - 1 -and $BigEndian[$i] -eq 0) { $i++ }
  $value = @($BigEndian[$i..($BigEndian.Length - 1)])
  if ($value[0] -band 0x80) { $value = @([byte] 0) + $value }
  return ConvertTo-Der 0x02 ([byte[]] $value)
}

function ConvertTo-Pem([string] $Label, [byte[]] $Der) {
  $base64 = [Convert]::ToBase64String($Der) -replace '(.{64})', "`$1`n"
  return "-----BEGIN $Label-----`n$($base64.TrimEnd("`n"))`n-----END $Label-----`n"
}

# The server's certificate and key for localhost, signed by a certificate
# authority made for this and trusted on this PC. The authority's key lives
# only in memory and is gone when this returns: nothing else can ever be
# signed with it.
function New-KitCertificate([string] $Folder) {
  $sha256 = [System.Security.Cryptography.HashAlgorithmName]::SHA256
  $pkcs1 = [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
  $x509 = "System.Security.Cryptography.X509Certificates"
  $now = [DateTimeOffset]::UtcNow

  $authorityKey = [System.Security.Cryptography.RSACng]::new(2048)
  $authorityRequest = New-Object "$x509.CertificateRequest" $CertSubject, $authorityKey, $sha256, $pkcs1
  $authorityRequest.CertificateExtensions.Add((New-Object "$x509.X509BasicConstraintsExtension" $true, $true, 0, $true))
  $authorityRequest.CertificateExtensions.Add((New-Object "$x509.X509KeyUsageExtension" ([System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign), $true))
  $authority = $authorityRequest.CreateSelfSigned($now.AddDays(-1), $now.AddDays(30))

  $key = [System.Security.Cryptography.RSACng]::new(2048)
  $request = New-Object "$x509.CertificateRequest" "CN=localhost", $key, $sha256, $pkcs1
  $names = New-Object "$x509.SubjectAlternativeNameBuilder"
  $names.AddDnsName("localhost")
  $names.AddIpAddress([System.Net.IPAddress]::Loopback)
  $request.CertificateExtensions.Add($names.Build())
  $request.CertificateExtensions.Add((New-Object "$x509.X509BasicConstraintsExtension" $false, $false, 0, $true))
  $serverAuth = New-Object System.Security.Cryptography.OidCollection
  [void] $serverAuth.Add((New-Object System.Security.Cryptography.Oid "1.3.6.1.5.5.7.3.1"))
  $request.CertificateExtensions.Add((New-Object "$x509.X509EnhancedKeyUsageExtension" $serverAuth, $false))
  $serial = New-Object byte[] 16
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($serial)
  $serial[0] = $serial[0] -band 0x7f
  $certificate = $request.Create($authority, $now.AddDays(-1), $now.AddDays(29), $serial)

  # Trust the authority's public half only, then forget its key.
  $public = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($authority.RawData)
  $authority.Dispose()
  $authorityKey.Dispose()
  $store = [System.Security.Cryptography.X509Certificates.X509Store]::new("Root", "LocalMachine")
  $store.Open("ReadWrite")
  try { $store.Add($public) } finally { $store.Close() }

  # The server's files: its certificate, and its key (PKCS #1).
  $p = $key.ExportParameters($true)
  $body = @(0x02, 0x01, 0x00)
  foreach ($part in $p.Modulus, $p.Exponent, $p.D, $p.P, $p.Q, $p.DP, $p.DQ, $p.InverseQ) {
    $body += ConvertTo-DerInteger $part
  }
  $keyPem = ConvertTo-Pem "RSA PRIVATE KEY" (ConvertTo-Der 0x30 ([byte[]] $body))
  $certPath = Join-Path $Folder "localhost.crt"
  $keyPath = Join-Path $Folder "localhost.key"
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($certPath, (ConvertTo-Pem "CERTIFICATE" $certificate.RawData), $utf8)
  [System.IO.File]::WriteAllText($keyPath, $keyPem, $utf8)
  $key.Dispose()
  return @{ Cert = $certPath; Key = $keyPath }
}

function Remove-Kit {
  Stop-KitProcesses
  Remove-KitCertificate
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
Remove-KitCertificate

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
  # The extension's server, as the real installer hands it over.
  $environment = Join-Path $b.Policies "3rdparty\extensions\$ExtensionId\policy\environment"
  if (-not (Test-Path $environment)) { New-Item -Path $environment -Force | Out-Null }
  New-ItemProperty -Path $environment -Name "base" -Value $ServerUrl -PropertyType String -Force | Out-Null
}

# The test server, with its data in the kit's folder.
$serverDir = Join-Path $Data "server"
New-Item -ItemType Directory -Force (Join-Path $serverDir "data") | Out-Null
Copy-Item (Join-Path $Kit "server\vaultwarden.exe") $serverDir -Force
$tls = New-KitCertificate $serverDir
$env:DATA_FOLDER = Join-Path $serverDir "data"
$env:WEB_VAULT_FOLDER = Join-Path $Kit "web-vault"
$env:WEB_VAULT_ENABLED = "true"
$env:ROCKET_ADDRESS = "127.0.0.1"
$env:ROCKET_PORT = "$Port"
# Forward slashes: backslashes would be escapes in this setting's syntax.
$env:ROCKET_TLS = "{certs=`"$($tls.Cert -replace '\\', '/')`",key=`"$($tls.Key -replace '\\', '/')`"}"
$env:DOMAIN = $ServerUrl
$env:SIGNUPS_ALLOWED = "true"
$env:SIGNUPS_VERIFY = "false"
$env:DISABLE_ICON_DOWNLOAD = "true"
$env:LOG_FILE = Join-Path $serverDir "server.log"
Start-Process -FilePath (Join-Path $serverDir "vaultwarden.exe") -WorkingDirectory $serverDir -WindowStyle Hidden
$up = $false
$why = "no answer"
for ($try = 0; $try -lt 60 -and -not $up; $try++) {
  Start-Sleep -Milliseconds 500
  try { $up = (Invoke-WebRequest -Uri "$ServerUrl/alive" -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200 } catch { $why = $_.Exception.Message }
}
if (-not $up) {
  $log = if (Test-Path $env:LOG_FILE) { (Get-Content $env:LOG_FILE -Tail 15) -join "`n" } else { "(no log)" }
  throw "The test server didn't answer at $ServerUrl ($why). The end of its log, $($env:LOG_FILE):`n$log"
}

# The agent, as you: it shows in the tray.
Start-Process -FilePath (Join-Path $agentDir "passbundle-agent.exe")

if ($Quiet) { return }

Write-Output @"

PassBundle test kit is running.

  Test server: $ServerUrl
  Agent: in the tray (the PassBundle lock icon)

If Chrome or Edge was open, close it completely first, so it picks up the
test server's certificate and the extension's settings.

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
