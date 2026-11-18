# Tier 2: the agent's update task, end to end. Run as admin on a disposable
# Windows machine (CI runner or VM), after Test-Install.ps1: it installs
# PassBundle to Program Files, runs the SYSTEM update task, and removes it
# all, then puts back the policies Test-Install.ps1 left for the browser check.
#
# installer/windows/update-test, which tier2-windows.yml makes, holds:
#   0.1.1\PassBundle, 0.1.2\PassBundle  two releases' folders (passbundle-apps'
#       tools/release-folder.sh) of the same app, with a test build of the
#       agent that has a throwaway update key and a stand-in for the update
#       site (http://127.0.0.1:8719/agent) compiled in, as only test builds
#       may; each also has update-test.txt saying its version, and a file the
#       other doesn't (only-0.1.1.txt, only-0.1.2.txt)
#   site\agent  what the stand-in serves: 0.1.2's zip, its manifest, and the
#       manifest's signature with the throwaway key
# 0.1.1 is installed as an RMM would, and the update task takes it to 0.1.2:
# not from a download that isn't the signed one, and not while something
# runs from the folder.
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$test = Join-Path $PSScriptRoot "..\update-test"
if (-not (Test-Path (Join-Path $test "site\agent\windows-x86_64.json"))) {
  Write-Output "skip  no test release next to the script; update task checks not run"
  exit 0
}
$failures = 0
function Check([string] $Name, [scriptblock] $Condition) {
  if (& $Condition) { Write-Output "ok    $Name" }
  else { Write-Output "FAIL  $Name"; $script:failures++ }
}

$installDir = Join-Path $env:ProgramFiles "PassBundle"
$work = Join-Path $env:ProgramFiles ".PassBundle-agent-update"
$task = "PassBundle agent update"
$hostManifest = Join-Path $installDir "com.passbundle.agent.json"
$old = (Resolve-Path (Join-Path $test "0.1.1\PassBundle")).Path
$new = (Resolve-Path (Join-Path $test "0.1.2\PassBundle")).Path
$site = (Resolve-Path (Join-Path $test "site")).Path
$zip = Join-Path $site "agent\PassBundle-0.1.2-windows-x64.zip"

# An RMM's package with 0.1.1: the install script, the agent's two programs,
# and the app's release folder.
$package = Join-Path $env:TEMP "pb-update-package"
if (Test-Path $package) { Remove-Item -Path $package -Recurse -Force }
New-Item -ItemType Directory -Path (Join-Path $package "agent") | Out-Null
Copy-Item -Path (Join-Path $PSScriptRoot "..\Install-PassBundle.ps1") -Destination $package
Copy-Item -Path (Join-Path $old "passbundle-agent.exe"), (Join-Path $old "passbundle-agent-host.exe") -Destination (Join-Path $package "agent")
Copy-Item -Path $old -Destination (Join-Path $package "app") -Recurse
$script = Join-Path $package "Install-PassBundle.ps1"

function Get-InstalledVersion {
  $release = Join-Path $installDir "release.json"
  if (-not (Test-Path $release)) { return $null }
  (Get-Content -Path $release -Raw | ConvertFrom-Json).version
}

# Whether the installed folder holds exactly the release folder $From's
# files, the same, and besides them only the install script's host manifest.
function Test-SameAs([string] $From) {
  $want = @(Get-ChildItem -Path $From -Recurse -File | ForEach-Object { $_.FullName.Substring($From.Length) } | Sort-Object)
  $have = @(Get-ChildItem -Path $installDir -Recurse -File | ForEach-Object { $_.FullName.Substring($installDir.Length) } |
      Where-Object { $_ -ne "\com.passbundle.agent.json" } | Sort-Object)
  if (Compare-Object $want $have) { return $false }
  foreach ($file in $want) {
    if ((Get-FileHash -Path (Join-Path $From $file)).Hash -ne (Get-FileHash -Path (Join-Path $installDir $file)).Hash) { return $false }
  }
  $true
}

# Runs the update task as Windows does (as SYSTEM), waits for it to end, and
# returns its exit code.
function Invoke-UpdateTask {
  $before = (Get-ScheduledTaskInfo -TaskName $task).LastRunTime
  # Its last run time is to the second.
  Start-Sleep -Seconds 2
  Start-ScheduledTask -TaskName $task | Out-Null
  for ($try = 0; $try -lt 600; $try++) {
    Start-Sleep -Milliseconds 500
    $info = Get-ScheduledTaskInfo -TaskName $task
    if ($info.LastRunTime -ne $before -and (Get-ScheduledTask -TaskName $task).State -ne "Running") {
      Write-Host "      (the update task ended with $($info.LastTaskResult))"
      return $info.LastTaskResult
    }
  }
  throw "The update task didn't end within 5 minutes"
}

$sids = @{
  System = "S-1-5-18"
  Administrators = "S-1-5-32-544"
  TrustedInstaller = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
  Users = "S-1-5-32-545"
}
function Get-Rules([string] $Path) {
  foreach ($rule in (Get-Acl -Path $Path).Access) {
    if ($rule.AccessControlType -ne "Allow") { continue }
    [pscustomobject]@{
      Sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
      Rights = $rule.FileSystemRights
    }
  }
}
# Users may read and run the file, and no one but SYSTEM, Administrators,
# and TrustedInstaller may change it.
function Test-RunByAllChangedByAdmins([string] $Path) {
  $change = [System.Security.AccessControl.FileSystemRights]"Write, Delete, ChangePermissions, TakeOwnership"
  $run = [System.Security.AccessControl.FileSystemRights]"ReadAndExecute"
  $rules = @(Get-Rules $Path)
  $usersRun = $rules | Where-Object { $_.Sid -eq $sids.Users -and ($_.Rights -band $run) -eq $run }
  $othersChange = $rules | Where-Object {
    @($sids.System, $sids.Administrators, $sids.TrustedInstaller) -notcontains $_.Sid -and ($_.Rights -band $change) -ne 0
  }
  [bool] $usersRun -and -not $othersChange
}

$server = $null
try {
  # A clean start: what Test-Install.ps1 left goes, and the RMM installs 0.1.1.
  & $script -Remove | Out-Null
  & $script | Out-Null
  Check "0.1.1 is installed from its release" { (Get-InstalledVersion) -eq "0.1.1" -and (Test-SameAs $old) }
  Check "with the host's manifest beside it" { Test-Path $hostManifest }
  Check "and the SYSTEM update task" { (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue).Principal.UserId -eq "SYSTEM" }
  $hostManifestHash = (Get-FileHash -Path $hostManifest).Hash

  # The stand-in for the update site.
  $server = Start-Process -FilePath "python" -ArgumentList "-m", "http.server", "8719", "--bind", "127.0.0.1", "--directory", "`"$site`"" -PassThru -WindowStyle Hidden
  $up = $false
  for ($try = 0; $try -lt 60 -and -not $up; $try++) {
    try {
      Invoke-WebRequest -Uri "http://127.0.0.1:8719/agent/windows-x86_64.json" -UseBasicParsing | Out-Null
      $up = $true
    } catch { Start-Sleep -Milliseconds 250 }
  }
  Check "The stand-in for the update site is up" { $up }

  # A download that isn't the one the manifest signs: one byte changed.
  $real = [System.IO.File]::ReadAllBytes($zip)
  $tampered = [byte[]] $real.Clone()
  $at = $tampered.Length - 100
  $tampered[$at] = $tampered[$at] -bxor 1
  [System.IO.File]::WriteAllBytes($zip, $tampered)
  $result = Invoke-UpdateTask
  Check "A download that isn't the signed one is refused" { $result -ne 0 }
  Check "and 0.1.1 stays as it was" { (Get-InstalledVersion) -eq "0.1.1" -and (Test-SameAs $old) }
  Check "with nothing of it left" { -not (Test-Path $work) }
  [System.IO.File]::WriteAllBytes($zip, $real)

  # Someone's agent runs from the folder: the update waits.
  $agent = Start-Process -FilePath (Join-Path $installDir "passbundle-agent.exe") -ArgumentList "--serve" -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 2
  Check "The agent is running" { -not $agent.HasExited }
  $result = Invoke-UpdateTask
  Check "While the agent runs, the task ends well" { $result -eq 0 }
  Check "and leaves 0.1.1 in place" { (Get-InstalledVersion) -eq "0.1.1" -and (Test-SameAs $old) }
  Check "with 0.1.2 checked and waiting" { Test-Path (Join-Path $work "staged.json") }
  Stop-Process -Id $agent.Id -Force -ErrorAction SilentlyContinue
  $agent.WaitForExit(10000) | Out-Null

  # Nothing runs from it, as when the computer starts: 0.1.2 goes in.
  $result = Invoke-UpdateTask
  Check "With nothing running from it, the task puts 0.1.2 in place" { $result -eq 0 -and (Get-InstalledVersion) -eq "0.1.2" }
  Check "The agent, its host, and the app are 0.1.2's, and nothing else is there" { Test-SameAs $new }
  Check "0.1.2's own files came, and 0.1.1's went" {
    (Get-Content -Path (Join-Path $installDir "update-test.txt")) -eq "0.1.2" -and
      (Test-Path (Join-Path $installDir "only-0.1.2.txt")) -and -not (Test-Path (Join-Path $installDir "only-0.1.1.txt"))
  }
  Check "The host's manifest is as the install script wrote it" { (Get-FileHash -Path $hostManifest).Hash -eq $hostManifestHash }
  foreach ($program in "passbundle.exe", "passbundle-agent.exe", "passbundle-agent-host.exe") {
    Check "Everyone can run the new $program, and only administrators can change it" {
      Test-RunByAllChangedByAdmins (Join-Path $installDir $program)
    }
  }
  $data = Join-Path $env:TEMP "pb-update-app"
  $app = Start-Process -FilePath (Join-Path $installDir "passbundle.exe") -PassThru -Environment @{ PB_DATA_DIR = $data; PB_SECRETS = "memory" }
  Start-Sleep -Seconds 8
  Check "The new app opens and stays open" { -not $app.HasExited }
  Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
  Get-Process -Name "passbundle", "passbundle-agent" -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2

  # The next run: nothing newer, and what the last one couldn't remove (its
  # own program, which was running) goes.
  $result = Invoke-UpdateTask
  Check "The next run finds nothing newer and leaves nothing behind" {
    $result -eq 0 -and (Get-InstalledVersion) -eq "0.1.2" -and -not (Test-Path $work)
  }

  # The RMM turns updates off: the task, and anything waiting, go.
  New-Item -ItemType Directory -Path $work -Force | Out-Null
  & $script -DisableAgentUpdates | Out-Null
  Check "With updates off there's no update task" { -not (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) }
  Check "and no update waiting" { -not (Test-Path $work) }
  $said = & (Join-Path $installDir "passbundle-agent.exe") --update
  Check "and the agent updates nothing" { $said -eq "Updates are turned off by policy." }

  New-Item -ItemType Directory -Path $work -Force | Out-Null
  & $script -Remove | Out-Null
  Check "Remove takes PassBundle away" { -not (Test-Path $installDir) }
  Check "and the update task's folder" { -not (Test-Path $work) }
} finally {
  if ($server) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
  Get-Process -Name "passbundle", "passbundle-agent", "passbundle-agent-host" -ErrorAction SilentlyContinue | Stop-Process -Force
  # Back to what Test-Install.ps1 left, for the browser check that follows.
  & (Join-Path $PSScriptRoot "..\Install-PassBundle.ps1") -DisableCardAutofill | Out-Null
  if (Test-Path $package) { Remove-Item -Path $package -Recurse -Force }
}

if ($failures) { Write-Output "$failures check(s) failed"; exit 1 }
Write-Output "all checks passed"
