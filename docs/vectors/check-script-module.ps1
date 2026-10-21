# Checks the script access PowerShell module (PassBundle.psm1, served by the
# server) against script-access-v1.json and RFC 6238's one-time codes. Tier 1
# runs it on Windows under Windows PowerShell 5.1 and PowerShell 7, and the
# end-to-end suite runs it on Linux. Prints each check; exits 1 if any fail.
#
#   pwsh -File docs/vectors/check-script-module.ps1 -Module PassBundle.psm1 -Vectors docs/vectors/script-access-v1.json
param(
    [Parameter(Mandatory = $true)] [string] $Module,
    [Parameter(Mandatory = $true)] [string] $Vectors
)

$ErrorActionPreference = 'Stop'
$m = Import-Module (Resolve-Path $Module) -PassThru -Force
$v = Get-Content $Vectors -Raw | ConvertFrom-Json

$failed = & $m {
    param($v)
    $tally = @{ failures = 0 }
    function Check([string] $What, $Seen, $Expected) {
        if ("$Seen" -ceq "$Expected") {
            Write-Host "ok    $What"
        } else {
            Write-Host "FAIL  $What`n      expected: $Expected`n      seen:     $Seen"
            $tally.failures++
        }
    }
    function Refusal([string] $What, [scriptblock] $Action, [string] $Expected) {
        try {
            & $Action | Out-Null
            Check $What 'opened' "refused: $Expected"
        } catch {
            Check $What ($(if ($_.Exception.Message.Contains($Expected)) { "refused: $Expected" } else { $_.Exception.Message })) "refused: $Expected"
        }
    }

    $t = Read-PassBundleToken $v.tokenString
    Check 'token id' $t.Id $v.inputs.tokenId
    Check 'auth secret' (ConvertTo-PassBundleBase64Url $t.Secret) $v.authSecret
    Check 'token key' ([Convert]::ToBase64String($t.Key)) $v.tokenKey

    $copy = Open-PassBundleCopy $t ([pscustomobject]@{ copy = $v.copy.encString; itemId = $v.inputs.itemId })
    $plain = $v.copy.plaintext | ConvertFrom-Json
    foreach ($name in 'token', 'item', 'name', 'username', 'password') { Check "copy $name" $copy.$name $plain.$name }
    Check 'copy field' $copy.fields.'Break-glass PIN' $plain.fields.'Break-glass PIN'
    # Kept as written, not turned into a date.
    Check 'copy revision' ("{0}: {1}" -f $copy.revision.GetType().Name, $copy.revision) `
        ("String: " + [regex]::Match($v.copy.plaintext, '"revision":"([^"]+)"').Groups[1].Value)

    foreach ($bad in $v.refused) {
        Refusal "refuses $($bad.why)" { Unprotect-PassBundleString -Encrypted $bad.encString -Key $t.Key } 'integrity check'
    }
    foreach ($bad in $v.mismatched) {
        Refusal "refuses $($bad.why)" {
            Open-PassBundleCopy $t ([pscustomobject]@{ copy = $bad.encString; itemId = $v.inputs.itemId })
        } 'made for another token or item'
    }
    Refusal 'refuses a token that is not one' { Read-PassBundleToken 'pbs1_nope' } 'isn''t a PassBundle script token'
    Refusal 'refuses Steam codes' { Get-PassBundleTotp 'steam://JBSWY3DPEHPK3PXP' } 'Steam'

    # RFC 6238, appendix B: 8 digits at these times, with each hash.
    $seeds = @{
        SHA1   = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
        SHA256 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA'
        SHA512 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA'
    }
    $rfc = @(
        @(59, '94287082', '46119246', '90693936'),
        @(1111111109, '07081804', '68084774', '25091201'),
        @(1111111111, '14050471', '67062674', '99943326'),
        @(1234567890, '89005924', '91819424', '93441116'),
        @(2000000000, '69279037', '90698825', '38618901'),
        @(20000000000, '65353130', '77737706', '47863826')
    )
    foreach ($row in $rfc) {
        $at = [DateTimeOffset]::FromUnixTimeSeconds([long]$row[0])
        $i = 1
        foreach ($algorithm in 'SHA1', 'SHA256', 'SHA512') {
            $address = 'otpauth://totp/Test?secret={0}&digits=8&algorithm={1}' -f $seeds[$algorithm], $algorithm
            Check "one-time code, $algorithm at $($row[0])" (Get-PassBundleTotp $address -At $at) $row[$i]
            $i++
        }
    }
    # A plain secret: 6 digits, SHA-1, 30 seconds; lower case and spaces allowed.
    Check 'one-time code from a plain secret' (Get-PassBundleTotp 'gezd gnbv gy3t qojq gezd gnbv gy3t qojq' -At ([DateTimeOffset]::FromUnixTimeSeconds(59))) '287082'

    $tally.failures
} $v

Write-Host ("PowerShell {0}: {1}" -f $PSVersionTable.PSVersion, $(if ($failed -eq 0) { 'all passed' } else { "$failed failed" }))
if ($failed -ne 0) { exit 1 }
