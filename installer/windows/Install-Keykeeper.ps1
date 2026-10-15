<#
.SYNOPSIS
  Applies Keykeeper's browser policies on a Windows machine. Version 0: policies only, no MSI yet.

.DESCRIPTION
  Run once with admin rights, typically from an RMM. For each targeted browser it:
    - force-installs the Keykeeper extension (IDs are fixed in this script, never passed in),
    - turns off the browser's own password saving and filling,
    - optionally turns off card and address autofill,
    - optionally gives the extension its server address and the client's
      enrollment token, so people join the client after they sign in.
  Existing policies from other vendors are left alone. Running it again changes nothing.

.EXAMPLE
  .\Install-Keykeeper.ps1 -Browsers Edge,Chrome -DisableCardAutofill
.EXAMPLE
  .\Install-Keykeeper.ps1 -ServerUrl https://vault.example.com -EnrollmentToken <token from the MSP console>
.EXAMPLE
  .\Install-Keykeeper.ps1 -Remove
#>
[CmdletBinding()]
param(
  [ValidateSet("Edge", "Chrome")]
  [string[]] $Browsers = @("Edge", "Chrome"),
  [switch] $DisableCardAutofill,
  [switch] $DisableAddressAutofill,
  [switch] $KeepBrowserPasswordManager,
  # The server the extension signs in to. HTTPS only.
  [ValidatePattern('^https://[^\s/?#]+(/[^\s?#]*)?$')]
  [string] $ServerUrl,
  # The client's enrollment token, from the MSP console.
  [ValidatePattern('^[A-Za-z0-9_-]{43}$')]
  [string] $EnrollmentToken,
  [switch] $Remove
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# The only extensions this script can ever force-install. Placeholders until
# the store listings exist; the store assigns the real IDs.
$Extensions = @{
  Chrome = @{ Id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; UpdateUrl = "https://clients2.google.com/service/update2/crx" }
  Edge   = @{ Id = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"; UpdateUrl = "https://edge.microsoft.com/extensionwebstorebase/v1/crx" }
}
$PolicyRoots = @{
  Chrome = "HKLM:\SOFTWARE\Policies\Google\Chrome"
  Edge   = "HKLM:\SOFTWARE\Policies\Microsoft\Edge"
}

function Set-Dword([string] $Path, [string] $Name, [int] $Value) {
  if (-not (Test-Path $Path)) { New-Item -Path $Path -Force | Out-Null }
  New-ItemProperty -Path $Path -Name $Name -Value $Value -PropertyType DWord -Force | Out-Null
}

function Get-ForcelistEntries([string] $Path) {
  if (-not (Test-Path $Path)) { return @() }
  $item = Get-Item -Path $Path
  foreach ($name in $item.GetValueNames()) {
    [pscustomobject]@{ Name = $name; Value = [string] $item.GetValue($name) }
  }
}

function Add-ForcedExtension([string] $Browser) {
  $ext = $Extensions[$Browser]
  $path = Join-Path $PolicyRoots[$Browser] "ExtensionInstallForcelist"
  $entries = @(Get-ForcelistEntries $path)
  if ($entries | Where-Object { $_.Value -like "$($ext.Id);*" -or $_.Value -eq $ext.Id }) { return }
  if (-not (Test-Path $path)) { New-Item -Path $path -Force | Out-Null }
  $used = @($entries | Where-Object { $_.Name -match '^\d+$' } | ForEach-Object { [int] $_.Name })
  $next = 1
  while ($used -contains $next) { $next++ }
  New-ItemProperty -Path $path -Name "$next" -Value "$($ext.Id);$($ext.UpdateUrl)" -PropertyType String -Force | Out-Null
}

# Settings the browser hands our extension (chrome.storage.managed), under the
# extension's own policy key, which no other vendor uses.
function Get-ManagedPolicyPath([string] $Browser) {
  Join-Path $PolicyRoots[$Browser] "3rdparty\extensions\$($Extensions[$Browser].Id)\policy"
}

function Set-ManagedSettings([string] $Browser) {
  $path = Get-ManagedPolicyPath $Browser
  if ($ServerUrl) {
    $environment = Join-Path $path "environment"
    if (-not (Test-Path $environment)) { New-Item -Path $environment -Force | Out-Null }
    New-ItemProperty -Path $environment -Name "base" -Value $ServerUrl.TrimEnd("/") -PropertyType String -Force | Out-Null
  }
  if ($EnrollmentToken) {
    if (-not (Test-Path $path)) { New-Item -Path $path -Force | Out-Null }
    New-ItemProperty -Path $path -Name "enrollmentToken" -Value $EnrollmentToken -PropertyType String -Force | Out-Null
  }
}

function Remove-ManagedSettings([string] $Browser) {
  $extensionKey = Split-Path (Get-ManagedPolicyPath $Browser) -Parent
  if (Test-Path $extensionKey) { Remove-Item -Path $extensionKey -Recurse -Force }
}

function Remove-ForcedExtension([string] $Browser) {
  $ext = $Extensions[$Browser]
  $path = Join-Path $PolicyRoots[$Browser] "ExtensionInstallForcelist"
  foreach ($entry in @(Get-ForcelistEntries $path)) {
    if ($entry.Value -like "$($ext.Id);*" -or $entry.Value -eq $ext.Id) {
      Remove-ItemProperty -Path $path -Name $entry.Name
    }
  }
}

foreach ($browser in $Browsers) {
  $root = $PolicyRoots[$browser]
  if ($Remove) {
    Remove-ForcedExtension $browser
    Remove-ManagedSettings $browser
    foreach ($name in "PasswordManagerEnabled", "AutofillCreditCardEnabled", "AutofillAddressEnabled") {
      if ((Test-Path $root) -and ((Get-Item $root).GetValueNames() -contains $name)) {
        Remove-ItemProperty -Path $root -Name $name
      }
    }
    Write-Output "Removed Keykeeper policies for $browser"
    continue
  }

  Add-ForcedExtension $browser
  Set-ManagedSettings $browser
  if (-not $KeepBrowserPasswordManager) { Set-Dword $root "PasswordManagerEnabled" 0 }
  if ($DisableCardAutofill) { Set-Dword $root "AutofillCreditCardEnabled" 0 }
  if ($DisableAddressAutofill) { Set-Dword $root "AutofillAddressEnabled" 0 }
  Write-Output "Applied Keykeeper policies for $browser"
}
