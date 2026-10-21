<#
.SYNOPSIS
  Sets PassBundle up on a Windows machine: browser policies and the desktop agent.

.DESCRIPTION
  Run once with admin rights, typically from an RMM. For each targeted browser it:
    - force-installs the PassBundle extension (IDs are fixed in this script, never passed in),
    - turns off the browser's own password saving and filling,
    - optionally turns off card and address autofill,
    - optionally gives the extension its server address and the client's
      enrollment token, join secret, and organization key fingerprint, so
      people join the client after they sign in (the extension asks first,
      and checks the organization's key against the fingerprint).
  With the agent's files in an "agent" folder next to this script, it also
  installs the desktop agent to Program Files: it starts at every sign-in,
  the browsers can reach it for Windows Hello unlock (our extension only), and
  a SYSTEM task installs its signed updates. Without them, policies only.
  Existing policies from other vendors are left alone. Running it again changes nothing.

.EXAMPLE
  .\Install-PassBundle.ps1 -Browsers Edge,Chrome -DisableCardAutofill
.EXAMPLE
  .\Install-PassBundle.ps1 -ServerUrl https://vault.example.com -EnrollmentToken <token> -JoinSecret <secret> -OrgKey <fingerprint>
  (the MSP console's install command has all three)
.EXAMPLE
  .\Install-PassBundle.ps1 -DisableAgentUpdates   # the RMM updates the agent instead
.EXAMPLE
  .\Install-PassBundle.ps1 -Remove
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
  # The install command's join secret, which the server never sees: joins
  # prove they know it. See DESIGN.md, "Joins a hacked server can't forge".
  [ValidatePattern('^[A-Za-z0-9_-]{43}$')]
  [string] $JoinSecret,
  # The fingerprint of the client's organization key, which the extension
  # checks before it escrows anything for account recovery.
  [ValidatePattern('^[A-Za-z0-9_-]{43}$')]
  [string] $OrgKey,
  # The agent doesn't update itself; the RMM pushes new versions instead.
  [switch] $DisableAgentUpdates,
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

# The desktop agent. See DESIGN.md, "Desktop agent" and "Biometric unlock".
$AgentSource = Join-Path $PSScriptRoot "agent"
$InstallDir = Join-Path $env:ProgramFiles "PassBundle"
$AgentFiles = @("passbundle-agent.exe", "passbundle-agent-host.exe")
# The native-messaging host's name: brand.json's nativeMessagingHost.
$HostName = "com.passbundle.agent"
$HostRoots = @{
  Chrome = "HKLM:\SOFTWARE\Google\Chrome\NativeMessagingHosts"
  Edge   = "HKLM:\SOFTWARE\Microsoft\Edge\NativeMessagingHosts"
}
$RunKey = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run"
$RunName = "PassBundle"
$AgentPolicy = "HKLM:\SOFTWARE\Policies\PassBundle\Agent"
$UpdateTask = "PassBundle agent update"

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
  if ($JoinSecret) {
    if (-not (Test-Path $path)) { New-Item -Path $path -Force | Out-Null }
    New-ItemProperty -Path $path -Name "joinSecret" -Value $JoinSecret -PropertyType String -Force | Out-Null
  }
  if ($OrgKey) {
    if (-not (Test-Path $path)) { New-Item -Path $path -Force | Out-Null }
    New-ItemProperty -Path $path -Name "orgKeyFingerprint" -Value $OrgKey -PropertyType String -Force | Out-Null
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

function Test-AgentSource {
  -not ($AgentFiles | Where-Object { -not (Test-Path (Join-Path $AgentSource $_)) })
}

# Copies a file into place unless it's already there. A running agent can't be
# overwritten, but it can be moved aside; it deletes the old copy when it next starts.
function Copy-AgentFile([string] $Name) {
  $from = Join-Path $AgentSource $Name
  $to = Join-Path $InstallDir $Name
  if ((Test-Path $to) -and (Get-FileHash $to).Hash -eq (Get-FileHash $from).Hash) { return }
  if (Test-Path $to) { Move-Item -Path $to -Destination "$to.old" -Force }
  Copy-Item -Path $from -Destination $to
}

function Install-Agent {
  if (-not (Test-Path $InstallDir)) { New-Item -Path $InstallDir -ItemType Directory | Out-Null }
  foreach ($name in $AgentFiles) { Copy-AgentFile $name }

  # The native-messaging host, for our extensions only.
  $manifest = Join-Path $InstallDir "$HostName.json"
  $json = [ordered]@{
    name            = $HostName
    description     = "PassBundle desktop agent"
    path            = Join-Path $InstallDir "passbundle-agent-host.exe"
    type            = "stdio"
    allowed_origins = @($Extensions.Values | ForEach-Object { "chrome-extension://$($_.Id)/" } | Sort-Object)
  } | ConvertTo-Json
  # UTF-8 without a byte-order mark, which browsers' JSON parsers expect.
  [System.IO.File]::WriteAllText($manifest, $json, (New-Object System.Text.UTF8Encoding $false))
  foreach ($browser in $Browsers) {
    $key = Join-Path $HostRoots[$browser] $HostName
    if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
    Set-Item -Path $key -Value $manifest
  }

  # Every person who signs in gets their own agent.
  New-ItemProperty -Path $RunKey -Name $RunName -Value "`"$(Join-Path $InstallDir 'passbundle-agent.exe')`"" -PropertyType String -Force | Out-Null

  # The agent's own settings.
  if (-not (Test-Path $AgentPolicy)) { New-Item -Path $AgentPolicy -Force | Out-Null }
  if ($ServerUrl) {
    New-ItemProperty -Path $AgentPolicy -Name "ServerUrl" -Value $ServerUrl.TrimEnd("/") -PropertyType String -Force | Out-Null
  }
  if ($DisableAgentUpdates) {
    Set-Dword $AgentPolicy "Updates" 0
    if (Get-ScheduledTask -TaskName $UpdateTask -ErrorAction SilentlyContinue) {
      Unregister-ScheduledTask -TaskName $UpdateTask -Confirm:$false
    }
  } else {
    if ((Get-Item $AgentPolicy).GetValueNames() -contains "Updates") { Remove-ItemProperty -Path $AgentPolicy -Name "Updates" }
    # Signed updates, daily and at startup, with the rights to replace the agent.
    # The agent checks each release's signature itself (see agent/README.md in passbundle-apps).
    $action = New-ScheduledTaskAction -Execute (Join-Path $InstallDir "passbundle-agent.exe") -Argument "--update"
    $triggers = @((New-ScheduledTaskTrigger -Daily -At "3:17am"), (New-ScheduledTaskTrigger -AtStartup))
    $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
    Register-ScheduledTask -TaskName $UpdateTask -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Force | Out-Null
  }
  Write-Output "Installed the PassBundle desktop agent to $InstallDir; it starts when people next sign in"
}

function Remove-Agent {
  Get-Process -Name "passbundle-agent", "passbundle-agent-host" -ErrorAction SilentlyContinue | Stop-Process -Force
  if (Get-ScheduledTask -TaskName $UpdateTask -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $UpdateTask -Confirm:$false
  }
  if ((Get-Item $RunKey).GetValueNames() -contains $RunName) { Remove-ItemProperty -Path $RunKey -Name $RunName }
  foreach ($root in $HostRoots.Values) {
    $key = Join-Path $root $HostName
    if (Test-Path $key) { Remove-Item -Path $key -Recurse -Force }
  }
  $policyRoot = Split-Path $AgentPolicy -Parent
  if (Test-Path $policyRoot) { Remove-Item -Path $policyRoot -Recurse -Force }
  if (Test-Path $InstallDir) { Remove-Item -Path $InstallDir -Recurse -Force }
  Write-Output "Removed the PassBundle desktop agent"
}

if ($Remove) {
  Remove-Agent
} elseif (Test-AgentSource) {
  Install-Agent
} else {
  Write-Warning "No desktop agent next to this script ($AgentSource): browser policies only."
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
    Write-Output "Removed PassBundle policies for $browser"
    continue
  }

  Add-ForcedExtension $browser
  Set-ManagedSettings $browser
  if (-not $KeepBrowserPasswordManager) { Set-Dword $root "PasswordManagerEnabled" 0 }
  if ($DisableCardAutofill) { Set-Dword $root "AutofillCreditCardEnabled" 0 }
  if ($DisableAddressAutofill) { Set-Dword $root "AutofillAddressEnabled" 0 }
  Write-Output "Applied PassBundle policies for $browser"
}
