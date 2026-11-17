$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$utf8 = [System.Text.UTF8Encoding]::new($false, $true)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8

try {
    $raw = [Console]::In.ReadToEnd()
    if ($utf8.GetByteCount($raw) -gt 65536) { throw 'input too large' }
    $inputObject = $raw | ConvertFrom-Json -NoEnumerate
    if ($null -eq $inputObject -or $inputObject -is [System.Array]) { throw 'invalid input' }
    $properties = @($inputObject.PSObject.Properties.Name)
    if ($properties.Count -ne 3 -or @($properties | Where-Object { $_ -notin @('operation', 'value', 'purpose') }).Count -ne 0) { throw 'invalid input' }
    if ($inputObject.operation -isnot [string] -or $inputObject.value -isnot [string] -or $inputObject.purpose -isnot [string]) { throw 'invalid input' }
    if ($inputObject.purpose -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$') { throw 'invalid purpose' }

    $entropy = $utf8.GetBytes('letta-companion:bilibili-account:' + $inputObject.purpose)
    if ($inputObject.operation -eq 'protect') {
        $plainBytes = $utf8.GetBytes($inputObject.value)
        if ($plainBytes.Length -gt 32768) { throw 'value too large' }
        $protectedBytes = [System.Security.Cryptography.ProtectedData]::Protect(
            $plainBytes,
            $entropy,
            [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        $result = [Convert]::ToBase64String($protectedBytes)
        if ($result.Length -gt 32768) { throw 'result too large' }
    }
    elseif ($inputObject.operation -eq 'unprotect') {
        if ($inputObject.value.Length -eq 0 -or $inputObject.value.Length -gt 32768 -or $inputObject.value.Length % 4 -ne 0 -or $inputObject.value -notmatch '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$') { throw 'invalid ciphertext' }
        $protectedBytes = [Convert]::FromBase64String($inputObject.value)
        $plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
            $protectedBytes,
            $entropy,
            [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        if ($plainBytes.Length -gt 32768) { throw 'result too large' }
        $result = $utf8.GetString($plainBytes)
    }
    else { throw 'invalid operation' }

    $output = @{ result = $result } | ConvertTo-Json -Compress
    [Console]::Out.Write($output)
    exit 0
}
catch {
    [Console]::Error.Write('credential operation failed')
    exit 1
}
