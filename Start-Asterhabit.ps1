[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
# 使用脚本所在工作区启动，不依赖当前终端目录。
$Entry = Join-Path $PSScriptRoot 'asterhabit\scripts\desktop-run.mjs'
$Node = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
& $Node $Entry
if ($LASTEXITCODE -ne 0) { throw 'Asterhabit 启动入口失败' }
