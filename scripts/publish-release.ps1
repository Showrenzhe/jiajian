[CmdletBinding()]
param([Parameter(Mandatory)][string]$Tag, [Parameter(Mandatory)][string]$Notes,
      [Parameter(Mandatory)][string]$Destination)
$ErrorActionPreference = 'Stop'
$version = (Get-Content -Raw -Encoding utf8 "$PSScriptRoot/../package.json" | ConvertFrom-Json).version
if ($Tag -cne "v$version") { throw '标签与安装包版本不符。' }
node "$PSScriptRoot/stage-update.cjs" "$PSScriptRoot/../dist" $Destination $version $Notes
if ($LASTEXITCODE) { throw '准备内部更新目录失败。' }
