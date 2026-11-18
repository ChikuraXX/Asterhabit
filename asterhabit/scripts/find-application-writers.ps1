param([Parameter(Mandatory=$true)][string]$ProjectRoot)
$ErrorActionPreference = 'Stop'
# 只读枚举已知桌面/聊天写者，不输出命令行、不自动终止进程。
$resolvedRoot = [IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\')
$writers = @(Get-CimInstance Win32_Process | Where-Object {
  $_.ProcessId -ne $PID -and (
    ($_.Name -in @('asterhabit-desktop.exe','letta-companion-desktop.exe') -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($resolvedRoot + '\',[StringComparison]::OrdinalIgnoreCase)) -or
    ($_.Name -match '^(node|bun)(\.exe)?$' -and $_.CommandLine -match '(?i)(desktop-service\.mjs|chat-memory\.mjs|scripts[\\/]chat\.mjs)')
  )
} | ForEach-Object { @{pid=[int]$_.ProcessId;name=[string]$_.Name} })
ConvertTo-Json -InputObject $writers -Compress
