# JIAJIAN_TOOLS_URL 可指定同一 ZIP 的 HTTPS 来源。私有 GitHub Release 可用
# https://api.github.com/repos/OWNER/REPO/releases/assets/ASSET_ID 和只读 GH_TOKEN。
# 其他来源如需授权，设置该来源专用的 JIAJIAN_TOOLS_TOKEN。
[CmdletBinding()]
param([string]$Archive, [string]$ToolsDirectory = (Join-Path $PSScriptRoot '../tools/ffmpeg-8.0-full_build'))

$ErrorActionPreference = 'Stop'
$archiveHash = '48ca5e824d2660a94f89fd55287b7c35129b55bbe680c4330efeed5269c4820f'
$files = [ordered]@{
    'bin/ffmpeg.exe' = '81b5832f6c548d64feba0ec7d643397e2351d9f3460a65c6c296956045eebaea'
    'bin/ffprobe.exe' = '421dbc81a3d758dfe114534ff48ef47a61ef91896eb4b9e819609a8752ab8272'
    'LICENSE' = '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903'
    'README.txt' = '3f887c5c1c7f1e4f5699f50939a7c9afd84e36324132d7352bf551c51f8e930e'
}

function Save-ToolArchive([string]$Destination) {
    $source = $env:JIAJIAN_TOOLS_URL
    if (!$source) { $source = 'https://github.com/GyanD/codexffmpeg/releases/download/8.0/ffmpeg-8.0-full_build.zip' }
    $uri = $null
    if (![uri]::TryCreate($source, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne 'https' -or $uri.UserInfo) {
        throw '工具包地址必须是有效的 HTTPS 地址，且不能包含用户名或密码。'
    }
    $url = $uri.GetComponents([UriComponents]::HttpRequestUrl, [UriFormat]::UriEscaped)
    if ($url -match '["\\\x00-\x1f]') { throw '工具包地址含有不支持的字符。' }
    $token = $env:JIAJIAN_TOOLS_TOKEN
    if (!$token -and $uri.IsDefaultPort -and $uri.IdnHost -in 'github.com', 'api.github.com') {
        $token = $env:GH_TOKEN
    }
    $config = @("url = `"$url`"")
    if ($token) {
        if ($token -cnotmatch '\A[A-Za-z0-9._~+/-]+=*\z') { throw '工具包下载令牌格式无效。' }
        $config += "header = `"Authorization: Bearer $token`""
    }

    # Keep credentials and signed URLs off the process command line. curl drops
    # Authorization on cross-origin redirects. Allow only HTTPS transfers.
    $status = '000'
    $PSNativeCommandUseErrorActionPreference = $false
    try {
        $options = @('--disable', '--config', '-', '--globoff', '--proto', '=https', '--proto-redir', '=https',
            '--location', '--fail', '--silent', '--retry', '3', '--header', 'Accept: application/octet-stream',
            '--write-out', '%{http_code}', '--output', $Destination)
        $status = $config | curl.exe @options 2>$null
        if ($LASTEXITCODE -eq 0 -and $status -match '^2\d\d$') { return }
    } catch {
        # Native errors can include the URL. Report only the origin and HTTP status.
    }
    $detail = if ($status -match '^[1-5]\d\d$') { "HTTP $status" } else { '未收到 HTTP 响应' }
    throw "下载 FFmpeg 8.0 工具包失败（$($uri.GetLeftPart([UriPartial]::Authority))，$detail）。若仓库已转私有，需要提供令牌。"
}

function Test-ToolFiles {
    foreach ($name in $files.Keys) {
        $file = Join-Path $ToolsDirectory $name
        if (!(Test-Path -LiteralPath $file -PathType Leaf) -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $files[$name]) {
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
        Save-ToolArchive $Archive
    }
    if ((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash -ne $archiveHash) {
        throw '离线包 SHA-256 与固定版本不符。'
    }
    $zip = [IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $Archive).Path)
    try {
        foreach ($name in $files.Keys) {
            $suffix = "/ffmpeg-8.0-full_build/$name"
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
