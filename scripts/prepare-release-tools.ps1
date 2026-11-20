[CmdletBinding()]
param([string]$Archive, [string]$ToolsDirectory = (Join-Path $PSScriptRoot '../tools/ffmpeg-8.0-full_build'))

$ErrorActionPreference = 'Stop'
$archiveUrl = 'https://github.com/Showrenzhe/jiajian/releases/download/v0.6.2/Jiajian-v0.6.2-Windows-x64-offline.zip'
$archiveHash = '9abf1dfbe1868d4aaab954f53c8de8a89bedf0a52d1dcf20b76558f9a2d67003'
$files = [ordered]@{
    'bin/ffmpeg.exe' = '81b5832f6c548d64feba0ec7d643397e2351d9f3460a65c6c296956045eebaea'
    'bin/ffprobe.exe' = '421dbc81a3d758dfe114534ff48ef47a61ef91896eb4b9e819609a8752ab8272'
    'LICENSE' = '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903'
    'README.txt' = '3f887c5c1c7f1e4f5699f50939a7c9afd84e36324132d7352bf551c51f8e930e'
}

function Test-ToolFiles {
    foreach ($name in $files.Keys) {
        $file = Join-Path $ToolsDirectory $name
        if (!(Test-Path -LiteralPath $file -PathType Leaf) -or (Get-FileHash -LiteralPath $file).Hash -ne $files[$name]) {
            return $false
        }
    }
    return $true
}

if (!$Archive -and (Test-ToolFiles)) {
    Write-Output '已验证本地 FFmpeg、FFprobe 和许可文件。'
    return
}

$downloaded = $false
try {
    if (!$Archive) {
        $Archive = [IO.Path]::GetTempFileName()
        $downloaded = $true
        curl.exe --fail --location --silent --show-error --retry 3 --output $Archive $archiveUrl
        if ($LASTEXITCODE -ne 0) { throw '下载 v0.6.2 官方离线包失败。' }
    }
    if ((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash -ne $archiveHash) {
        throw '离线包 SHA-256 与固定版本不符。'
    }
    $zip = [IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $Archive).Path)
    try {
        foreach ($name in $files.Keys) {
            $suffix = "/tools/ffmpeg-8.0-full_build/$name"
            $entries = @($zip.Entries | Where-Object { ('/' + $_.FullName.Replace('\','/')).EndsWith($suffix, [StringComparison]::Ordinal) })
            if ($entries.Count -ne 1) { throw "离线包缺少唯一的 $suffix" }
            $destination = Join-Path $ToolsDirectory $name
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination))
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entries[0], $destination, $true)
        }
    } finally {
        $zip.Dispose()
    }
    if (!(Test-ToolFiles)) { throw '解包后的 FFmpeg 工具或许可文件校验失败。' }
    Write-Output '已恢复并验证正式构建使用的 FFmpeg、FFprobe 和许可文件。'
} finally {
    if ($downloaded) { Remove-Item -LiteralPath $Archive }
}
