# Tier 2: running the install script again while PassBundle runs. Run as
# admin on a disposable Windows machine (CI runner or VM), after
# Test-Install.ps1: it installs PassBundle to Program Files, runs the agent,
# its browser helper, and the app from there, installs over them, and removes
# it all, then puts back what Test-Install.ps1 left for the browser check.
#
# It needs the agent and the app that tier2-windows.yml builds next to the
# install script (installer/windows/agent and installer/windows/app). From
# them it makes two RMM packages, each with the agent's two programs in the
# app's folder too, as a release's folder has them:
#   first   the programs as they were built
#   second  the same programs with a few bytes added at the end, which
#           Windows doesn't read: they run as before, and to the install
#           script they're another build
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$agentBuild = Join-Path $PSScriptRoot "..\agent"
$appBuild = Join-Path $PSScriptRoot "..\app"
if (-not (Test-Path (Join-Path $agentBuild "passbundle-agent.exe")) -or -not (Test-Path (Join-Path $appBuild "passbundle.exe"))) {
  Write-Output "skip  no agent and app builds next to the script; checks of running it again not run"
  exit 0
}
$failures = 0
function Check([string] $Name, [scriptblock] $Condition) {
  if (& $Condition) { Write-Output "ok    $Name" }
  else { Write-Output "FAIL  $Name"; $script:failures++ }
}

$installDir = Join-Path $env:ProgramFiles "PassBundle"
$programs = "passbundle-agent.exe", "passbundle-agent-host.exe"
$agentPath = Join-Path $installDir "passbundle-agent.exe"
$hostPath = Join-Path $installDir "passbundle-agent-host.exe"
$packages = Join-Path $env:TEMP "pb-rerun"
$appData = Join-Path $env:TEMP "pb-rerun-app"

# An RMM's package: the install script, the agent's two programs, and the
# app's folder with the agent's programs in it too. -Rebuilt adds the bytes.
function New-Package([string] $Package, [switch] $Rebuilt) {
  $agent = Join-Path $Package "agent"
  $app = Join-Path $Package "app"
  New-Item -ItemType Directory -Path $agent, $app -Force | Out-Null
  Copy-Item -Path (Join-Path $PSScriptRoot "..\Install-PassBundle.ps1") -Destination $Package
  Copy-Item -Path (Join-Path $appBuild "*") -Destination $app -Recurse
  foreach ($program in $programs) {
    $file = Join-Path $agent $program
    Copy-Item -Path (Join-Path $agentBuild $program) -Destination $file
    if ($Rebuilt) {
      $stream = [System.IO.File]::Open($file, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write)
      try { $stream.Write([byte[]] @(0x50, 0x42, 0x0D, 0x0A), 0, 4) } finally { $stream.Dispose() }
    }
    Copy-Item -Path $file -Destination $app
  }
}

# Runs a package's install script as an RMM would. Says whether it ended
# well, and what it said if it stopped.
function Invoke-Install([string] $Package, [hashtable] $With = @{}) {
  try {
    & (Join-Path $Package "Install-PassBundle.ps1") @With | Out-Null
    [pscustomobject]@{ Ok = $true; Message = "" }
  } catch {
    Write-Host "      (the script stopped: $($_.Exception.Message))"
    [pscustomobject]@{ Ok = $false; Message = $_.Exception.Message }
  }
}

# Whether the installed agent and browser helper are the package's.
function Test-Installed([string] $Package) {
  foreach ($program in $programs) {
    $installed = Join-Path $installDir $program
    if (-not (Test-Path -LiteralPath $installed)) { return $false }
    if ((Get-FileHash -LiteralPath $installed).Hash -ne (Get-FileHash -LiteralPath (Join-Path $Package "agent\$program")).Hash) { return $false }
  }
  $true
}

# What's beside the installed programs: those moved aside, and new copies.
function Get-Aside {
  @(Get-ChildItem -LiteralPath $installDir -File |
      Where-Object { $_.Name -like "*.old" -or $_.Name -like "*.new" } |
      ForEach-Object { $_.Name } | Sort-Object)
}

# Ends every PassBundle program and waits until they have.
function Stop-PassBundle {
  $running = @(Get-Process -Name "passbundle", "passbundle-agent", "passbundle-agent-host" -ErrorAction SilentlyContinue)
  if (-not $running) { return }
  $running | Stop-Process -Force -ErrorAction SilentlyContinue
  $running | Wait-Process -Timeout 30 -ErrorAction SilentlyContinue
}

function Start-Agent {
  $agent = Start-Process -FilePath $agentPath -ArgumentList "--serve" -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 2
  $agent
}

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

# The installed browser helper, started as a browser starts it, once it has
# reached the running agent; it keeps running until Stop-BrowserHelper.
# $null if it doesn't reach it in $Tries tries.
function Start-BrowserHelper([int] $Tries) {
  for ($try = 0; $try -lt $Tries; $try++) {
    Start-Sleep -Milliseconds 500
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $hostPath
    $startInfo.Arguments = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $helper = [System.Diagnostics.Process]::Start($startInfo)
    if ((Read-Frame $helper.StandardOutput.BaseStream) -eq '{"command":"connected"}') { return $helper }
    Stop-BrowserHelper $helper
  }
  $null
}

# As a browser closes it: its input ends.
function Stop-BrowserHelper($Helper) {
  if (-not $Helper) { return }
  $Helper.StandardInput.Close()
  if (-not $Helper.WaitForExit(5000)) { $Helper.Kill(); $Helper.WaitForExit(5000) | Out-Null }
}

if (Test-Path $packages) { Remove-Item -Path $packages -Recurse -Force }
$first = Join-Path $packages "first"
$second = Join-Path $packages "second"
New-Package $first
New-Package $second -Rebuilt
$agent = $null
$helper = $null
$lock = $null
try {
  # A clean start: what Test-Install.ps1 left goes, and the RMM installs the first build.
  Stop-PassBundle
  $ran = Invoke-Install $first @{ Remove = $true }
  $ran = Invoke-Install $first
  Check "The first build installs" { $ran.Ok -and (Test-Installed $first) -and @(Get-Aside).Count -eq 0 }

  # The same build again while the agent, its browser helper, and the app
  # run. The app's folder holds the agent's programs too, and the script used
  # to copy them over the running agent and stop there.
  $agent = Start-Agent
  $helper = Start-BrowserHelper 20
  $app = Start-Process -FilePath (Join-Path $installDir "passbundle.exe") -PassThru -Environment @{ PB_DATA_DIR = $appData; PB_SECRETS = "memory" }
  Start-Sleep -Seconds 8
  Check "The agent, its browser helper, and the app run" { -not $agent.HasExited -and $helper -and -not $app.HasExited }
  $ran = Invoke-Install $first
  Check "Running the script again while they run works" { $ran.Ok }
  Check "and leaves the agent's programs as they were, with nothing beside them" { (Test-Installed $first) -and @(Get-Aside).Count -eq 0 }
  Check "The agent and its browser helper keep running" { -not $agent.HasExited -and $helper -and -not $helper.HasExited }
  Check "The app was closed so its files could be replaced" { $app.HasExited }

  # Another build while the agent and its browser helper run: each is moved
  # aside, to a name of its own, and keeps running.
  $ran = Invoke-Install $second
  Check "Installing another build while the agent and its browser helper run works" { $ran.Ok }
  Check "and puts that build's programs in place" { Test-Installed $second }
  $aside = @(Get-Aside)
  Check "The running agent and browser helper were moved aside, each to a name of its own" {
    $aside.Count -eq 2 -and
      @($aside | Where-Object { $_ -like "passbundle-agent.exe.*.old" }).Count -eq 1 -and
      @($aside | Where-Object { $_ -like "passbundle-agent-host.exe.*.old" }).Count -eq 1
  }
  Check "and keep running" { -not $agent.HasExited -and $helper -and -not $helper.HasExited }
  # For the record: whether a browser helper started now, the new build's,
  # reaches the agent that runs moved aside, until the person signs in again.
  $late = Start-BrowserHelper 3
  Write-Output "note  a browser helper started after the update reaches the agent moved aside: $([bool] $late)"
  Stop-BrowserHelper $late

  # Again, while the programs moved aside still run. The script used to move
  # each installed program to one name, <name>.old, over the running one,
  # and stop there.
  $ran = Invoke-Install $first
  Check "Installing again while the programs moved aside still run works" { $ran.Ok }
  Check "and puts the first build back" { Test-Installed $first }
  Check "What it moved aside, which nothing runs, is removed, and what still runs is left" { (@(Get-Aside) -join ",") -eq ($aside -join ",") }
  Check "The agent and its browser helper still run" { -not $agent.HasExited -and $helper -and -not $helper.HasExited }

  # Once they've ended, the next run removes them.
  Stop-BrowserHelper $helper
  $helper = $null
  Stop-PassBundle
  Start-Sleep -Seconds 2
  $ran = Invoke-Install $first
  Check "Once nothing runs them, the next run removes the programs moved aside" { $ran.Ok -and (Test-Installed $first) -and @(Get-Aside).Count -eq 0 }

  # A step that fails: the browser helper can't be moved aside (held open
  # without leave to rename it, as some programs that read files do), after
  # the agent was. All of it goes back, and the script says what to do.
  $agent = Start-Agent
  $lock = [System.IO.File]::Open($hostPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
  $ran = Invoke-Install $second
  $lock.Dispose()
  $lock = $null
  Check "When the browser helper can't be moved aside, the script stops" { -not $ran.Ok }
  Check "and says to sign out and back in, or restart, then run it again" { $ran.Message -like "*Sign out of Windows and back in*restart it, then run this script again*" }
  Check "The first build's programs are as they were, with nothing beside them" { (Test-Installed $first) -and @(Get-Aside).Count -eq 0 }
  Check "and the agent still runs" { -not $agent.HasExited }

  # Run again with nothing held open, the other build goes in; and -Remove
  # takes it all away, the agent moved aside and still running too.
  $ran = Invoke-Install $second
  Check "Run again, the other build goes in" { $ran.Ok -and (Test-Installed $second) }
  Check "with the running agent moved aside" { @(Get-Aside).Count -eq 1 -and -not $agent.HasExited }
  $ran = Invoke-Install $second @{ Remove = $true }
  Check "Remove ends the agent moved aside and takes everything away" { $ran.Ok -and $agent.HasExited -and -not (Test-Path $installDir) }
} finally {
  if ($lock) { $lock.Dispose() }
  if ($helper) { Stop-BrowserHelper $helper }
  Stop-PassBundle
  # Back to what Test-Install.ps1 left, for the browser check that follows.
  & (Join-Path $PSScriptRoot "..\Install-PassBundle.ps1") -DisableCardAutofill | Out-Null
  if (Test-Path $packages) { Remove-Item -Path $packages -Recurse -Force -ErrorAction SilentlyContinue }
  if (Test-Path $appData) { Remove-Item -Path $appData -Recurse -Force -ErrorAction SilentlyContinue }
}

if ($failures) { Write-Output "$failures check(s) failed"; exit 1 }
Write-Output "all checks passed"
