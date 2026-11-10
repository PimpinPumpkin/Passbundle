# Tier 2 checks for Install-PassBundle.ps1. Run as admin on a disposable
# Windows machine (CI runner or VM): it writes and removes machine policies.
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script = Join-Path $PSScriptRoot "..\Install-PassBundle.ps1"
$chromeRoot = "HKLM:\SOFTWARE\Policies\Google\Chrome"
$edgeRoot = "HKLM:\SOFTWARE\Policies\Microsoft\Edge"
$firefoxRoot = "HKLM:\SOFTWARE\Policies\Mozilla\Firefox"
$ownPolicies = "HKLM:\SOFTWARE\PassBundle\BrowserPolicies"
# PassBundle's own extension ID, which a build loaded by hand has (DESIGN.md,
# "PassBundle's extension IDs"): it gets the extension's settings and may
# reach the agent, and nothing force-installs it.
$ownId = "cenoidjoogmoieibpcokkafjnaabhokg"
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
# The extensions a browser has managed settings for, by ID.
function ManagedIds([string] $Root) {
  $path = "$Root\3rdparty\extensions"
  if (-not (Test-Path $path)) { return @() }
  @(Get-ChildItem $path | ForEach-Object { $_.PSChildName })
}

# Another vendor already force-installs an extension. We must not touch it.
$foreign = "cccccccccccccccccccccccccccccccc;https://clients2.google.com/service/update2/crx"
New-Item -Path "$chromeRoot\ExtensionInstallForcelist" -Force | Out-Null
New-ItemProperty -Path "$chromeRoot\ExtensionInstallForcelist" -Name "1" -Value $foreign -PropertyType String -Force | Out-Null

# What was there before us, so the checks below see only what we add.
$chromeHad = @(ManagedIds $chromeRoot)
$edgeHad = @(ManagedIds $edgeRoot)

$serverUrl = "https://vault.example.test"
$token = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456"
$joinSecret = "QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8"
$orgKey = "gpfywOP9ms6QtlYF65DLr2GSIBBe-lYsna8wlVbDQYE"
& $script -DisableCardAutofill -ServerUrl "$serverUrl/" -EnrollmentToken $token -JoinSecret $joinSecret -OrgKey $orgKey
& $script -DisableCardAutofill -ServerUrl "$serverUrl/" -EnrollmentToken $token -JoinSecret $joinSecret -OrgKey $orgKey   # second run must change nothing

$chromeList = Forcelist $chromeRoot
$edgeList = Forcelist $edgeRoot
Check "Chrome keeps the other vendor's extension" { $chromeList -contains $foreign }
Check "Chrome forces our extension exactly once" { @($chromeList | Where-Object { $_ -like "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;*" }).Count -eq 1 }
Check "Chrome forces nothing else of ours" { $chromeList.Count -eq 2 }
Check "Edge forces our extension exactly once" { @($edgeList | Where-Object { $_ -like "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb;*" }).Count -eq 1 }
Check "Edge forces nothing else" { @($edgeList).Count -eq 1 }
Check "Nothing force-installs our own extension ID" { -not (@(@($chromeList) + @($edgeList)) -like "*$ownId*") }
Check "Chrome password manager off" { (Dword $chromeRoot "PasswordManagerEnabled") -eq 0 }
Check "Edge password manager off" { (Dword $edgeRoot "PasswordManagerEnabled") -eq 0 }
Check "Chrome takes native-messaging hosts from the machine only" { (Dword $chromeRoot "NativeMessagingUserLevelHosts") -eq 0 }
Check "Edge takes native-messaging hosts from the machine only" { (Dword $edgeRoot "NativeMessagingUserLevelHosts") -eq 0 }
Check "Chrome card autofill off" { (Dword $chromeRoot "AutofillCreditCardEnabled") -eq 0 }
Check "Address autofill untouched" { $null -eq (Dword $chromeRoot "AutofillAddressEnabled") }
Check "Firefox card autofill off" { (Dword $firefoxRoot "AutofillCreditCardEnabled") -eq 0 }
Check "Firefox address autofill untouched" { $null -eq (Dword $firefoxRoot "AutofillAddressEnabled") }
Check "It records the card policies it set" { (Dword $ownPolicies "Firefox.AutofillCreditCardEnabled") -eq 1 }

# The organization's setting goes back to leave as is, so the install command
# loses its options: a run without them takes back only the card and address
# policies it set itself. Another vendor's Edge address policy stays.
New-ItemProperty -Path $edgeRoot -Name "AutofillAddressEnabled" -Value 0 -PropertyType DWord -Force | Out-Null
& $script -DisableCardAutofill -DisableAddressAutofill -ServerUrl "$serverUrl/" -EnrollmentToken $token | Out-Null
Check "Both off in Firefox with both options" {
  (Dword $firefoxRoot "AutofillCreditCardEnabled") -eq 0 -and (Dword $firefoxRoot "AutofillAddressEnabled") -eq 0
}
Check "Another vendor's policy isn't recorded as ours" { $null -eq (Dword $ownPolicies "Edge.AutofillAddressEnabled") }
& $script -ServerUrl "$serverUrl/" -EnrollmentToken $token | Out-Null
Check "Without the options, Chrome's card policy is taken back" { $null -eq (Dword $chromeRoot "AutofillCreditCardEnabled") }
Check "Without the options, Chrome's address policy is taken back" { $null -eq (Dword $chromeRoot "AutofillAddressEnabled") }
Check "Without the options, Firefox's are taken back" {
  $null -eq (Dword $firefoxRoot "AutofillCreditCardEnabled") -and $null -eq (Dword $firefoxRoot "AutofillAddressEnabled")
}
Check "Another vendor's Edge address policy stays" { (Dword $edgeRoot "AutofillAddressEnabled") -eq 0 }
Remove-ItemProperty -Path $edgeRoot -Name "AutofillAddressEnabled"
& $script -DisableCardAutofill -ServerUrl "$serverUrl/" -EnrollmentToken $token -JoinSecret $joinSecret -OrgKey $orgKey | Out-Null

# The extension's own settings: server address and enrollment token.
function Managed([string] $Root, [string] $Id, [string] $Sub, [string] $Name) {
  $path = "$Root\3rdparty\extensions\$Id\policy$Sub"
  if (-not (Test-Path $path)) { return $null }
  (Get-Item $path).GetValue($Name)
}
Check "Chrome extension gets the server address" { (Managed $chromeRoot "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" "\environment" "base") -eq $serverUrl }
Check "Chrome extension gets the enrollment token" { (Managed $chromeRoot "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" "" "enrollmentToken") -eq $token }
Check "Edge extension gets the enrollment token" { (Managed $edgeRoot "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" "" "enrollmentToken") -eq $token }
Check "Chrome extension gets the join secret" { (Managed $chromeRoot "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" "" "joinSecret") -eq $joinSecret }
Check "Edge extension gets the organization key fingerprint" { (Managed $edgeRoot "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" "" "orgKeyFingerprint") -eq $orgKey }
# A build loaded by hand has our own ID, so the same settings go there too.
Check "A Chrome extension loaded by hand gets the server address" { (Managed $chromeRoot $ownId "\environment" "base") -eq $serverUrl }
Check "A Chrome extension loaded by hand gets the enrollment token" { (Managed $chromeRoot $ownId "" "enrollmentToken") -eq $token }
Check "A Chrome extension loaded by hand gets the join secret" { (Managed $chromeRoot $ownId "" "joinSecret") -eq $joinSecret }
Check "A Chrome extension loaded by hand gets the organization key fingerprint" { (Managed $chromeRoot $ownId "" "orgKeyFingerprint") -eq $orgKey }
Check "An Edge extension loaded by hand gets the server address" { (Managed $edgeRoot $ownId "\environment" "base") -eq $serverUrl }
Check "An Edge extension loaded by hand gets the enrollment token" { (Managed $edgeRoot $ownId "" "enrollmentToken") -eq $token }
Check "An Edge extension loaded by hand gets the join secret" { (Managed $edgeRoot $ownId "" "joinSecret") -eq $joinSecret }
Check "An Edge extension loaded by hand gets the organization key fingerprint" { (Managed $edgeRoot $ownId "" "orgKeyFingerprint") -eq $orgKey }
# The settings go to our extensions only: each browser's store ID and our own.
Check "Chrome hands the settings to no other extension" {
  (@(ManagedIds $chromeRoot | Where-Object { $chromeHad -notcontains $_ } | Sort-Object) -join ",") -eq "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,$ownId"
}
Check "Edge hands the settings to no other extension" {
  (@(ManagedIds $edgeRoot | Where-Object { $edgeHad -notcontains $_ } | Sort-Object) -join ",") -eq "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb,$ownId"
}
Check "Still nothing force-installs our own extension ID" { -not (@(@(Forcelist $chromeRoot) + @(Forcelist $edgeRoot)) -like "*$ownId*") }

# Bad values are refused before anything is written.
$refusedHttp = $false
try { & $script -ServerUrl "http://vault.example.test" } catch { $refusedHttp = $true }
Check "Plain HTTP server addresses are refused" { $refusedHttp }
$refusedToken = $false
try { & $script -EnrollmentToken "not-a-token" } catch { $refusedToken = $true }
Check "Malformed enrollment tokens are refused" { $refusedToken }
$refusedSecret = $false
try { & $script -JoinSecret "x'; calc" } catch { $refusedSecret = $true }
Check "Malformed join secrets are refused" { $refusedSecret }
$refusedOrgKey = $false
try { & $script -OrgKey "short" } catch { $refusedOrgKey = $true }
Check "Malformed organization key fingerprints are refused" { $refusedOrgKey }

# The script has no way to force-install anything but our IDs: its parameters
# are exactly these, so a new one needs a review of this check.
$allowed = "Browsers", "DisableCardAutofill", "DisableAddressAutofill", "KeepBrowserPasswordManager", "ServerUrl", "EnrollmentToken", "JoinSecret", "OrgKey", "DisableAgentUpdates", "Remove"
$own = (Get-Command $script).Parameters.Keys | Where-Object { [System.Management.Automation.PSCmdlet]::CommonParameters -notcontains $_ -and [System.Management.Automation.PSCmdlet]::OptionalCommonParameters -notcontains $_ }
Check "Parameters are exactly the reviewed set" { -not (Compare-Object @($own | Sort-Object) @($allowed | Sort-Object)) }

# The desktop agent, when the agent's files are next to the script (Tier 2
# builds them into installer/windows/agent).
$installDir = Join-Path $env:ProgramFiles "PassBundle"
$hostName = "com.passbundle.agent"
$hostKeys = @(
  "HKLM:\SOFTWARE\Google\Chrome\NativeMessagingHosts\$hostName",
  "HKLM:\SOFTWARE\Microsoft\Edge\NativeMessagingHosts\$hostName"
)
$runKey = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run"
$agentPolicy = "HKLM:\SOFTWARE\Policies\PassBundle\Agent"
$updateTask = "PassBundle agent update"
$haveAgent = Test-Path (Join-Path $PSScriptRoot "..\agent\passbundle-agent.exe")

# Reads one native-messaging frame (4-byte length, then JSON) within 15 seconds.
function Read-Frame([System.IO.Stream] $Stream) {
  $read = {
    param([int] $Count)
    $buffer = New-Object byte[] $Count
    $done = 0
    while ($done -lt $Count) {
      $task = $Stream.ReadAsync($buffer, $done, $Count - $done)
      if (-not $task.Wait(15000) -or $task.Result -eq 0) { return $null }
      $done += $task.Result
    }
    , $buffer
  }
  $length = & $read 4
  if ($null -eq $length) { return $null }
  $body = & $read ([BitConverter]::ToUInt32($length, 0))
  if ($null -eq $body) { return $null }
  [System.Text.Encoding]::UTF8.GetString($body)
}

if ($haveAgent) {
  # Not $name: PowerShell names ignore case, and Check's parameter is $Name.
  foreach ($file in "passbundle-agent.exe", "passbundle-agent-host.exe") {
    Check "The agent's $file is installed" { Test-Path (Join-Path $installDir $file) }
  }
  $manifestPath = Join-Path $installDir "$hostName.json"
  $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
  Check "The host's manifest names our host and its program" {
    $manifest.name -eq $hostName -and $manifest.type -eq "stdio" -and (Test-Path $manifest.path)
  }
  Check "The host allows our extensions (the two store IDs and our own) and nothing else" {
    -not (Compare-Object @($manifest.allowed_origins) @(
        "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
        "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/",
        "chrome-extension://$ownId/"))
  }
  Check "The manifest has no byte-order mark" { [System.IO.File]::ReadAllBytes($manifestPath)[0] -eq [byte][char]"{" }
  foreach ($key in $hostKeys) {
    Check "The host is registered at $key" { (Get-Item $key).GetValue("") -eq $manifestPath }
  }
  Check "The agent starts at every sign-in" {
    (Get-Item $runKey).GetValue("PassBundle") -eq "`"$(Join-Path $installDir 'passbundle-agent.exe')`""
  }
  Check "The agent gets the server address" { (Get-Item $agentPolicy).GetValue("ServerUrl") -eq $serverUrl }
  $task = Get-ScheduledTask -TaskName $updateTask -ErrorAction SilentlyContinue
  Check "A SYSTEM task installs the agent's signed updates" {
    $task -and $task.Principal.UserId -eq "SYSTEM" -and $task.Actions[0].Arguments -eq "--update"
  }

  # The installed host reaches the installed agent, as the browser would start it.
  $agent = Start-Process -FilePath (Join-Path $installDir "passbundle-agent.exe") -PassThru
  $frame = $null
  for ($try = 0; $try -lt 20 -and -not $frame; $try++) {
    Start-Sleep -Milliseconds 500
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = Join-Path $installDir "passbundle-agent-host.exe"
    $startInfo.Arguments = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $hostProcess = [System.Diagnostics.Process]::Start($startInfo)
    $frame = Read-Frame $hostProcess.StandardOutput.BaseStream
    $hostProcess.StandardInput.Close()
    if (-not $hostProcess.WaitForExit(5000)) { $hostProcess.Kill() }
  }
  Check "The installed host reaches the running agent" { $frame -eq '{"command":"connected"}' }
  Stop-Process -Id $agent.Id -Force -ErrorAction SilentlyContinue

  # Updates off by the RMM's choice: no task, and the agent's policy says so.
  & $script -DisableAgentUpdates | Out-Null
  Check "With updates off there's no update task" { -not (Get-ScheduledTask -TaskName $updateTask -ErrorAction SilentlyContinue) }
  Check "With updates off the agent's policy says so" { (Get-Item $agentPolicy).GetValue("Updates") -eq 0 }
  & $script -DisableCardAutofill -ServerUrl "$serverUrl/" -EnrollmentToken $token | Out-Null
  Check "Updates come back on" {
    (Get-ScheduledTask -TaskName $updateTask -ErrorAction SilentlyContinue) -and $null -eq (Get-Item $agentPolicy).GetValue("Updates")
  }
} else {
  Write-Output "skip  no agent build next to the script; agent checks not run"
}

# The app, when its files are next to the script (Tier 2 builds them into installer/windows/app).
$haveApp = Test-Path (Join-Path $PSScriptRoot "..\app\passbundle.exe")
$shortcut = Join-Path $env:ProgramData "Microsoft\Windows\Start Menu\Programs\PassBundle.lnk"
if ($haveApp) {
  Check "The app is installed next to the agent" { Test-Path (Join-Path $installDir "passbundle.exe") }
  Check "The app's core is installed with it" { Test-Path (Join-Path $installDir "passbundle_core.dll") }
  Check "The Start menu has PassBundle" {
    (Test-Path $shortcut) -and ((New-Object -ComObject WScript.Shell).CreateShortcut($shortcut).TargetPath -eq (Join-Path $installDir "passbundle.exe"))
  }
  # It opens, from a folder of its own, and stays open.
  $data = Join-Path $env:TEMP "pb-installer-app"
  $app = Start-Process -FilePath (Join-Path $installDir "passbundle.exe") -PassThru -Environment @{ PB_DATA_DIR = $data; PB_SECRETS = "memory" }
  Start-Sleep -Seconds 8
  Check "The installed app opens and stays open" { -not $app.HasExited }
  Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
  Get-Process -Name "passbundle-agent" -ErrorAction SilentlyContinue | Stop-Process -Force
} else {
  Write-Output "skip  no app build next to the script; app checks not run"
}

if ($env:KK_SKIP_REMOVE -ne "1") {
  & $script -Remove
  Check "Remove keeps the other vendor's extension" { (Forcelist $chromeRoot) -contains $foreign }
  Check "Remove drops our Chrome extension" { -not ((Forcelist $chromeRoot) -like "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;*") }
  Check "Remove drops our Edge extension" { -not ((Forcelist $edgeRoot) -like "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb;*") }
  Check "Remove restores the password manager setting" { $null -eq (Dword $chromeRoot "PasswordManagerEnabled") }
  Check "Remove restores user-level native-messaging hosts" { $null -eq (Dword $edgeRoot "NativeMessagingUserLevelHosts") }
  Check "Remove drops the extension's settings" { -not (Test-Path "$chromeRoot\3rdparty\extensions\aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") }
  Check "Remove drops the Edge extension's settings" { -not (Test-Path "$edgeRoot\3rdparty\extensions\bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb") }
  Check "Remove drops the settings for an extension loaded by hand, in Chrome" { -not (Test-Path "$chromeRoot\3rdparty\extensions\$ownId") }
  Check "Remove drops the settings for an extension loaded by hand, in Edge" { -not (Test-Path "$edgeRoot\3rdparty\extensions\$ownId") }
  Check "Remove drops Firefox's card policy" { $null -eq (Dword $firefoxRoot "AutofillCreditCardEnabled") }
  Check "Remove forgets which policies it set" { -not (Test-Path $ownPolicies) }
  if ($haveAgent) {
    Check "Remove uninstalls the agent" { -not (Test-Path $installDir) }
    Check "Remove unregisters the host" { -not ($hostKeys | Where-Object { Test-Path $_ }) }
    Check "Remove stops the agent starting at sign-in" { -not ((Get-Item $runKey).GetValueNames() -contains "PassBundle") }
    Check "Remove drops the update task" { -not (Get-ScheduledTask -TaskName $updateTask -ErrorAction SilentlyContinue) }
    Check "Remove drops the agent's policy" { -not (Test-Path $agentPolicy) }
  }
  if ($haveApp) {
    Check "Remove uninstalls the app" { -not (Test-Path (Join-Path $installDir "passbundle.exe")) }
    Check "Remove drops the Start menu shortcut" { -not (Test-Path $shortcut) }
  }
  # Leave the policies applied for the browser check that follows.
  & $script -DisableCardAutofill | Out-Null
}

if ($failures) { Write-Output "$failures check(s) failed"; exit 1 }
Write-Output "all checks passed"
