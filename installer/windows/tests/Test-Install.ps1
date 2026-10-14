# Tier 2 checks for Install-Keykeeper.ps1. Run as admin on a disposable
# Windows machine (CI runner or VM): it writes and removes machine policies.
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script = Join-Path $PSScriptRoot "..\Install-Keykeeper.ps1"
$chromeRoot = "HKLM:\SOFTWARE\Policies\Google\Chrome"
$edgeRoot = "HKLM:\SOFTWARE\Policies\Microsoft\Edge"
$failures = 0

function Check([string] $Name, [scriptblock] $Condition) {
  if (& $Condition) { Write-Output "ok    $Name" }
  else { Write-Output "FAIL  $Name"; $script:failures++ }
}
function Forcelist([string] $Root) {
  $path = Join-Path $Root "ExtensionInstallForcelist"
  if (-not (Test-Path $path)) { return @() }
  $item = Get-Item $path
  @($item.GetValueNames() | ForEach-Object { [string] $item.GetValue($_) })
}
function Dword([string] $Root, [string] $Name) {
  if (-not (Test-Path $Root)) { return $null }
  (Get-Item $Root).GetValue($Name)
}

# Another vendor already force-installs an extension. We must not touch it.
$foreign = "cccccccccccccccccccccccccccccccc;https://clients2.google.com/service/update2/crx"
New-Item -Path "$chromeRoot\ExtensionInstallForcelist" -Force | Out-Null
New-ItemProperty -Path "$chromeRoot\ExtensionInstallForcelist" -Name "1" -Value $foreign -PropertyType String -Force | Out-Null

& $script -DisableCardAutofill
& $script -DisableCardAutofill   # second run must change nothing

$chromeList = Forcelist $chromeRoot
$edgeList = Forcelist $edgeRoot
Check "Chrome keeps the other vendor's extension" { $chromeList -contains $foreign }
Check "Chrome forces our extension exactly once" { @($chromeList | Where-Object { $_ -like "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;*" }).Count -eq 1 }
Check "Chrome forces nothing else of ours" { $chromeList.Count -eq 2 }
Check "Edge forces our extension exactly once" { @($edgeList | Where-Object { $_ -like "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb;*" }).Count -eq 1 }
Check "Chrome password manager off" { (Dword $chromeRoot "PasswordManagerEnabled") -eq 0 }
Check "Edge password manager off" { (Dword $edgeRoot "PasswordManagerEnabled") -eq 0 }
Check "Chrome card autofill off" { (Dword $chromeRoot "AutofillCreditCardEnabled") -eq 0 }
Check "Address autofill untouched" { $null -eq (Dword $chromeRoot "AutofillAddressEnabled") }

# The script has no way to force-install anything but our IDs.
$params = (Get-Command $script).Parameters.Keys
Check "No parameter accepts an extension ID" { -not ($params | Where-Object { $_ -cmatch "Id$|Extension|Url" }) }

if ($env:KK_SKIP_REMOVE -ne "1") {
  & $script -Remove
  Check "Remove keeps the other vendor's extension" { (Forcelist $chromeRoot) -contains $foreign }
  Check "Remove drops our Chrome extension" { -not ((Forcelist $chromeRoot) -like "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;*") }
  Check "Remove drops our Edge extension" { -not ((Forcelist $edgeRoot) -like "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb;*") }
  Check "Remove restores the password manager setting" { $null -eq (Dword $chromeRoot "PasswordManagerEnabled") }
  # Leave the policies applied for the browser check that follows.
  & $script -DisableCardAutofill | Out-Null
}

if ($failures) { Write-Output "$failures check(s) failed"; exit 1 }
Write-Output "all checks passed"
